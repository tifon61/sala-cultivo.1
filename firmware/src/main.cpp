// Firmware de la sala de cultivo.
//
// El ESP32 es "tonto" a propósito: mide, publica, y obedece las órdenes de
// relés que manda el servidor. Toda la lógica (horarios, umbrales) vive en el
// backend, así se cambia desde el celular sin volver a programar la placa.
//
// La única decisión propia es de seguridad: si deja de recibir órdenes durante
// FAILSAFE_MS (servidor caído, Wi-Fi cortado), pone cada relé en su estado seguro.

#include <Arduino.h>
#include <WiFi.h>
#include <Wire.h>
#include <PubSubClient.h>
#include <ArduinoJson.h>

#if __has_include("config.h")
#include "config.h"
#else
#error "Falta include/config.h: copiá include/config.example.h como config.h y completalo"
#endif

#ifdef USAR_SHT31
#include <Adafruit_SHT31.h>
Adafruit_SHT31 sht31;
bool sht31Ok = false;
#endif

#ifdef USAR_SCD4X
#include <SensirionI2cScd4x.h>
SensirionI2cScd4x scd4x;
bool scd4xOk = false;
#endif

struct Rele {
  const char* id;
  uint8_t pin;
  bool estadoSeguro;
  bool encendido;
};
Rele reles[] = RELES;
const size_t CANT_RELES = sizeof(reles) / sizeof(reles[0]);

WiFiClient wifi;
PubSubClient mqtt(wifi);

const String BASE = String("cultivo/") + DISPOSITIVO;
unsigned long ultimaOrdenMs = 0;
unsigned long ultimaTelemetriaMs = 0;
unsigned long ultimoIntentoMqttMs = 0;
bool enModoSeguro = true;

// ------------------------------------------------------------------- relés

void escribirPin(const Rele& r) {
  bool nivel = RELE_ACTIVO_BAJO ? !r.encendido : r.encendido;
  digitalWrite(r.pin, nivel ? HIGH : LOW);
}

void publicarEstadoRele(const Rele& r) {
  String topico = BASE + "/rele/" + r.id + "/estado";
  mqtt.publish(topico.c_str(), r.encendido ? "ON" : "OFF", true);  // retained
}

void aplicarRele(Rele& r, bool encender) {
  bool cambio = r.encendido != encender;
  r.encendido = encender;
  escribirPin(r);
  if (cambio) Serial.printf("Relé %s -> %s\n", r.id, encender ? "ON" : "OFF");
  if (mqtt.connected()) publicarEstadoRele(r);
}

void aplicarModoSeguro() {
  Serial.println("Sin órdenes del servidor: modo seguro");
  for (auto& r : reles) aplicarRele(r, r.estadoSeguro);
  enModoSeguro = true;
}

// -------------------------------------------------------------------- MQTT

// Llega un mensaje a cultivo/<dispositivo>/rele/<id>/set
void alRecibir(char* topico, byte* payload, unsigned int largo) {
  String t(topico);
  String valor;
  for (unsigned int i = 0; i < largo; i++) valor += (char)payload[i];
  valor.trim();
  valor.toUpperCase();

  String prefijo = BASE + "/rele/";
  if (!t.startsWith(prefijo) || !t.endsWith("/set")) return;
  String id = t.substring(prefijo.length(), t.length() - 4);

  for (auto& r : reles) {
    if (id == r.id) {
      aplicarRele(r, valor == "ON");
      ultimaOrdenMs = millis();
      enModoSeguro = false;
      return;
    }
  }
}

void conectarMqtt() {
  String estado = BASE + "/estado";
  String clientId = String("esp32-") + DISPOSITIVO;
  // "Testamento" (LWT): si el ESP32 se desconecta de golpe, el broker publica
  // "offline" por nosotros. Así la web sabe que se cayó.
  if (!mqtt.connect(clientId.c_str(), MQTT_USUARIO, MQTT_CLAVE, estado.c_str(), 1, true, "offline")) {
    Serial.printf("MQTT: no se pudo conectar (estado %d)\n", mqtt.state());
    return;
  }
  Serial.println("MQTT conectado");
  mqtt.publish(estado.c_str(), "online", true);
  mqtt.subscribe((BASE + "/rele/+/set").c_str(), 1);
  for (auto& r : reles) publicarEstadoRele(r);
}

// ---------------------------------------------------------------- sensores

void iniciarSensores() {
  Wire.begin(PIN_SDA, PIN_SCL);
#ifdef USAR_SHT31
  sht31Ok = sht31.begin(0x44);
  Serial.printf("SHT31: %s\n", sht31Ok ? "ok" : "NO ENCONTRADO");
#endif
#ifdef USAR_SCD4X
  scd4x.begin(Wire, SCD41_I2C_ADDR_62);
  scd4x.stopPeriodicMeasurement();  // por si quedó midiendo de un arranque anterior
  delay(500);
  scd4xOk = scd4x.startPeriodicMeasurement() == 0;
  Serial.printf("SCD4x: %s\n", scd4xOk ? "ok" : "NO ENCONTRADO");
#endif
#ifdef USAR_SUELO
  analogReadResolution(12);
#endif
}

void publicarTelemetria() {
  JsonDocument doc;

#ifdef USAR_SHT31
  if (sht31Ok) {
    float t = sht31.readTemperature();
    float h = sht31.readHumidity();
    if (!isnan(t)) doc["temperatura"] = round(t * 10) / 10.0;
    if (!isnan(h)) doc["humedad"] = round(h * 10) / 10.0;
  }
#endif

#ifdef USAR_SCD4X
  bool listo = false;
  if (scd4xOk && scd4x.getDataReadyStatus(listo) == 0 && listo) {
    uint16_t co2;
    float t, h;
    if (scd4x.readMeasurement(co2, t, h) == 0 && co2 > 0) {
      doc["co2"] = co2;
      doc["temperatura2"] = round(t * 10) / 10.0;
      doc["humedad2"] = round(h * 10) / 10.0;
    }
  }
#endif

#ifdef USAR_SUELO
  int crudo = analogRead(PIN_SUELO1);
  // Interpolación lineal: SUELO_SECO -> 0 %, SUELO_MOJADO -> 100 %
  float pct = 100.0 * (SUELO_SECO - crudo) / (SUELO_SECO - SUELO_MOJADO);
  doc["suelo1"] = (int)constrain(pct, 0.0f, 100.0f);
#endif

  doc["rssi"] = WiFi.RSSI();  // calidad de señal Wi-Fi, útil para diagnosticar

  char buffer[384];
  size_t n = serializeJson(doc, buffer);
  String topico = BASE + "/telemetria";
  mqtt.publish(topico.c_str(), (const uint8_t*)buffer, n, false);
  Serial.println(buffer);
}

// ------------------------------------------------------------------ setup/loop

void setup() {
  Serial.begin(115200);

  // Primero fijamos el nivel del pin y después lo hacemos salida,
  // para que los relés no "pestañeen" al arrancar.
  for (auto& r : reles) {
    r.encendido = r.estadoSeguro;
    escribirPin(r);
    pinMode(r.pin, OUTPUT);
  }

  iniciarSensores();

  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(true);
  WiFi.begin(WIFI_SSID, WIFI_CLAVE);

  mqtt.setServer(MQTT_HOST, MQTT_PUERTO);
  mqtt.setCallback(alRecibir);
  mqtt.setBufferSize(512);
}

void loop() {
  unsigned long ahora = millis();

  // Reconexión sin bloquear: un intento cada 5 s. Los relés siguen en su estado.
  if (WiFi.status() == WL_CONNECTED && !mqtt.connected() && ahora - ultimoIntentoMqttMs > 5000) {
    ultimoIntentoMqttMs = ahora;
    conectarMqtt();
  }
  mqtt.loop();

  if (!enModoSeguro && ahora - ultimaOrdenMs > FAILSAFE_MS) aplicarModoSeguro();

  if (mqtt.connected() && ahora - ultimaTelemetriaMs > INTERVALO_TELEMETRIA_MS) {
    ultimaTelemetriaMs = ahora;
    publicarTelemetria();
  }
}
