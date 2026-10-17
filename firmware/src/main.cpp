// Firmware de un módulo de sala de cultivo (ESP32).
//
// Dos "tareas" corren en paralelo (FreeRTOS):
//
//  * tareaControl (cada 1 s): lee sensores, evalúa las reglas y mueve los relés.
//    No depende de la red: si se corta internet, la sala sigue funcionando
//    con la última configuración guardada.
//
//  * loop() de Arduino: todo lo de red. Wi-Fi, MQTT con TLS hacia el servidor,
//    la red de emergencia (AP) con su página local, y el envío de mediciones
//    (incluidas las que se acumularon mientras no había conexión).
//
// Están separadas porque conectarse a un servidor puede bloquear varios
// segundos; si eso pasara en la misma tarea que el riego, un pulso de 20 s
// podría durar 35.

#include <Arduino.h>
#include <ArduinoJson.h>
#include <DHT.h>
#include <DNSServer.h>
#include <Preferences.h>
#include <PubSubClient.h>
#include <SensirionI2cScd4x.h>
#include <WebServer.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <Wire.h>
#include <esp_timer.h>
#include <sys/time.h>
#include <time.h>

#if __has_include("config.h")
#include "config.h"
#else
#error "Falta include/config.h: copiá include/config.example.h como config.h y completalo"
#endif

#include "certificados.h"
#include "config_sala.h"
#include "pagina_local.h"
#include "reglas.h"

// ======================================================================
// Estado compartido entre las dos tareas (siempre se toca con el candado)
// ======================================================================

struct PinRele {
  const char* id;
  uint8_t pin;
};
const PinRele PINES[] = RELES;
const int CANT_RELES = sizeof(PINES) / sizeof(PINES[0]);
static_assert(CANT_RELES <= reglas::MAX_RELES, "demasiados relés");
const char* IDS[CANT_RELES];

SemaphoreHandle_t candado;
struct Bloqueo {  // toma el candado al crearse y lo suelta al salir del bloque
  Bloqueo() { xSemaphoreTake(candado, portMAX_DELAY); }
  ~Bloqueo() { xSemaphoreGive(candado); }
};

ConfigSala cfg;
String cfgJson;            // la config como texto (se guarda tal cual en la flash)
bool cfgLocal = false;     // true si se cambió desde la página local
char cfgError[96] = "";
reglas::Lecturas lecturas;
bool encendido[reglas::MAX_RELES];
char motivo[reglas::MAX_RELES][72];
volatile bool cambioReles = true;  // avisa al loop que hay que reportar

// Variables medidas, en el orden en que se mandan.
const char* VARIABLES[] = {"temperatura", "humedad", "co2", "temperatura2", "humedad2", "dpv"};
const int CANT_VARIABLES = sizeof(VARIABLES) / sizeof(VARIABLES[0]);

// ======================================================================
// Red: valores guardados en la flash (Preferences = memoria NVS del ESP32)
// ======================================================================

struct Red {
  String ssid, clave, mqttHost, mqttClave;
  uint16_t mqttPuerto;
  bool tls;
} red;

Preferences prefs;
WiFiClientSecure clienteTls;
WiFiClient clientePlano;
PubSubClient mqtt;
WebServer web(80);
DNSServer dns;
DHT dht(PIN_DHT, DHT11);
SensirionI2cScd4x scd4x;
bool scdOk = false;

const String BASE = String("cultivo/") + DISPOSITIVO;
bool apActivo = false;
unsigned long ultimoMqttOk = 0, conectadoDesde = 0, ultimoIntentoMqtt = 0, ultimoIntentoWifi = 0;
unsigned long ultimaTelemetria = 0, ultimoReporte = 0;

// ======================================================================
// Tiempo
// ======================================================================

uint32_t uptimeS() { return (uint32_t)(esp_timer_get_time() / 1000000LL); }  // no se reinicia a los 49 días como millis()

reglas::Tiempo tiempoActual() {
  reglas::Tiempo t;
  time_t ahora = time(nullptr);
  t.hayHora = ahora > 1700000000;  // antes de 2023 = el reloj nunca se sincronizó
  t.epoch = ahora;
  struct tm local;
  localtime_r(&ahora, &local);
  t.segundosDelDia = local.tm_hour * 3600 + local.tm_min * 60 + local.tm_sec;
  t.uptimeS = uptimeS();
  return t;
}

// ======================================================================
// Configuración de la sala
// ======================================================================

// Valida y aplica una config. Si es inválida no cambia nada y guarda el error.
bool aplicarConfig(const char* texto, size_t largo, bool desdeLocal) {
  JsonDocument doc;
  if (deserializeJson(doc, texto, largo)) {
    Bloqueo b;
    snprintf(cfgError, sizeof(cfgError), "config recibida no es JSON válido");
    return false;
  }
  ConfigSala nueva;
  char error[96];
  if (!parsearConfig(doc.as<JsonVariantConst>(), IDS, CANT_RELES, nueva, error, sizeof(error))) {
    Bloqueo b;
    snprintf(cfgError, sizeof(cfgError), "%s", error);
    Serial.printf("Config rechazada: %s\n", error);
    return false;
  }
  String json;
  serializeJson(doc, json);
  {
    Bloqueo b;
    cfg = nueva;
    cfgLocal = desdeLocal;
    cfgError[0] = 0;
  }
  if (json != cfgJson) {  // no gastar la flash si no cambió
    cfgJson = json;
    prefs.putString("config", cfgJson);
    prefs.putBool("cfg_local", desdeLocal);
  }
  cambioReles = true;
  Serial.printf("Config aplicada (versión %d, %s)\n", nueva.version, desdeLocal ? "local" : "servidor");
  return true;
}

void cargarPreferencias() {
  prefs.begin("sala", false);
  red.ssid = prefs.getString("ssid", WIFI_SSID);
  red.clave = prefs.getString("clave", WIFI_CLAVE);
  red.mqttHost = prefs.getString("mhost", MQTT_HOST);
  red.mqttPuerto = prefs.getUShort("mport", MQTT_PUERTO);
  red.mqttClave = prefs.getString("mclave", MQTT_CLAVE);
  red.tls = prefs.getBool("tls", MQTT_TLS);

  String guardada = prefs.getString("config", "");
  bool local = prefs.getBool("cfg_local", false);
  if (guardada.isEmpty() || !aplicarConfig(guardada.c_str(), guardada.length(), local)) {
    const char* inicial = CONFIG_INICIAL;
    aplicarConfig(inicial, strlen(inicial), false);
  }
}

// ======================================================================
// Tarea de control: sensores + reglas + relés (no toca la red)
// ======================================================================

void escribirRele(int i, bool on) {
  bool nivel = RELE_ACTIVO_BAJO ? !on : on;
  digitalWrite(PINES[i].pin, nivel ? HIGH : LOW);
}

void medir() {
  uint32_t ahora = uptimeS();
  float t = dht.readTemperature();
  float h = dht.readHumidity();
  bool dhtOk = !isnan(t) && !isnan(h);

  uint16_t co2 = 0;
  float t2 = NAN, h2 = NAN;
  bool listo = false;
  bool scdNuevo = scdOk && scd4x.getDataReadyStatus(listo) == 0 && listo &&
                  scd4x.readMeasurement(co2, t2, h2) == 0 && co2 > 0;

  Bloqueo b;
  if (dhtOk) {
    lecturas.poner("temperatura", t, ahora);
    lecturas.poner("humedad", h, ahora);
  }
  if (scdNuevo) {
    lecturas.poner("co2", co2, ahora);
    lecturas.poner("temperatura2", t2, ahora);
    lecturas.poner("humedad2", h2, ahora);
  }
  // DPV con el DHT11; si el DHT11 falla, con la temperatura/humedad del SCD40.
  float tt, hh;
  if ((lecturas.buscar("temperatura", ahora, tt) && lecturas.buscar("humedad", ahora, hh)) ||
      (lecturas.buscar("temperatura2", ahora, tt) && lecturas.buscar("humedad2", ahora, hh))) {
    lecturas.poner("dpv", reglas::calcularDpv(tt, hh), ahora);
  }
}

void tareaControl(void*) {
  uint32_t ultimaMedicion = 0;
  for (;;) {
    if (ultimaMedicion == 0 || uptimeS() - ultimaMedicion >= 5) {  // DHT11: no más de 1 lectura/s
      ultimaMedicion = uptimeS();
      medir();
    }
    reglas::Tiempo t = tiempoActual();
    {
      Bloqueo b;
      for (int i = 0; i < CANT_RELES; i++) {
        reglas::Decision d = reglas::decidir(cfg.reles[i], t, lecturas, encendido[i]);
        if (d.encendido != encendido[i]) {
          Serial.printf("Relé %s -> %s (%s)\n", IDS[i], d.encendido ? "ON" : "OFF", d.motivo);
          cambioReles = true;
        }
        encendido[i] = d.encendido;
        memcpy(motivo[i], d.motivo, sizeof(motivo[i]));
        escribirRele(i, d.encendido);
      }
    }
    vTaskDelay(pdMS_TO_TICKS(1000));
  }
}

// ======================================================================
// Mediciones hacia el servidor (con memoria para cuando no hay conexión)
// ======================================================================

struct Muestra {
  int64_t ts;
  float valores[CANT_VARIABLES];
};
const int CAPACIDAD_BUFFER = 720;  // 6 h a una muestra cada 30 s (~30 KB de RAM)
Muestra buffer[CAPACIDAD_BUFFER];
int bufInicio = 0, bufCantidad = 0;

Muestra tomarMuestra() {
  Muestra m;
  m.ts = time(nullptr);
  uint32_t ahora = uptimeS();
  Bloqueo b;
  for (int i = 0; i < CANT_VARIABLES; i++) {
    if (!lecturas.buscar(VARIABLES[i], ahora, m.valores[i])) m.valores[i] = NAN;
  }
  return m;
}

bool publicarMuestra(const Muestra& m) {
  JsonDocument doc;
  if (m.ts > 1700000000) doc["ts"] = m.ts;
  for (int i = 0; i < CANT_VARIABLES; i++) {
    if (!isnan(m.valores[i])) doc[VARIABLES[i]] = roundf(m.valores[i] * 100) / 100;
  }
  doc["rssi"] = WiFi.RSSI();
  char texto[384];
  size_t n = serializeJson(doc, texto);
  return mqtt.publish((BASE + "/telemetria").c_str(), (const uint8_t*)texto, n, false);
}

void guardarEnBuffer(const Muestra& m) {
  if (m.ts < 1700000000) return;  // sin hora no sabríamos cuándo fue
  int pos = (bufInicio + bufCantidad) % CAPACIDAD_BUFFER;
  buffer[pos] = m;
  if (bufCantidad < CAPACIDAD_BUFFER) bufCantidad++;
  else bufInicio = (bufInicio + 1) % CAPACIDAD_BUFFER;  // lleno: se pisa la más vieja
}

void vaciarBuffer() {
  for (int enviados = 0; bufCantidad > 0 && enviados < 10; enviados++) {  // de a poco
    if (!publicarMuestra(buffer[bufInicio])) return;
    bufInicio = (bufInicio + 1) % CAPACIDAD_BUFFER;
    bufCantidad--;
  }
}

// Estado de los relés para el servidor (retained: el último queda guardado en el broker).
void reportarReles() {
  JsonDocument doc;
  {
    Bloqueo b;
    doc["version"] = cfg.version;
    doc["local"] = cfgLocal;
    if (cfgError[0]) doc["error"] = cfgError;
    for (int i = 0; i < CANT_RELES; i++) {
      JsonObject r = doc["reles"][IDS[i]].to<JsonObject>();
      r["on"] = encendido[i];
      r["motivo"] = motivo[i];
    }
  }
  doc["ap"] = apActivo;
  doc["hay_hora"] = tiempoActual().hayHora;
  doc["pendientes"] = bufCantidad;
  String texto;
  serializeJson(doc, texto);
  mqtt.publish((BASE + "/reles").c_str(), texto.c_str(), true);
}

// ======================================================================
// MQTT
// ======================================================================

void alRecibir(char* topico, uint8_t* payload, unsigned int largo) {
  if (BASE + "/config" == topico) {
    // La configuración del servidor siempre gana sobre la local.
    aplicarConfig((const char*)payload, largo, false);
  }
}

void conectarMqtt() {
  if (red.mqttHost.isEmpty()) return;
  mqtt.setClient(red.tls ? (Client&)clienteTls : (Client&)clientePlano);
  mqtt.setServer(red.mqttHost.c_str(), red.mqttPuerto);
  String estado = BASE + "/estado";
  String id = String("esp32-") + DISPOSITIVO;
  Serial.printf("MQTT: conectando a %s:%u%s...\n", red.mqttHost.c_str(), red.mqttPuerto, red.tls ? " (TLS)" : "");
  // Testamento (LWT): si nos caemos de golpe, el broker publica "offline" por nosotros.
  if (!mqtt.connect(id.c_str(), DISPOSITIVO, red.mqttClave.c_str(), estado.c_str(), 1, true, "offline")) {
    Serial.printf("MQTT: falló (estado %d)\n", mqtt.state());
    return;
  }
  Serial.println("MQTT conectado");
  conectadoDesde = millis();
  mqtt.publish(estado.c_str(), "online", true);
  mqtt.subscribe((BASE + "/config").c_str(), 1);  // llega enseguida porque es retained
  cambioReles = true;
}

// ======================================================================
// Red de emergencia (AP) + página local
// ======================================================================

void iniciarAp() {
  String nombre = String("Cultivo-") + DISPOSITIVO;
  WiFi.mode(WIFI_AP_STA);
  WiFi.softAP(nombre.c_str(), AP_CLAVE);
  dns.start(53, "*", WiFi.softAPIP());  // portal cautivo: cualquier dominio lleva a la página
  apActivo = true;
  cambioReles = true;
  Serial.printf("Red de emergencia activa: %s -> http://%s\n", nombre.c_str(), WiFi.softAPIP().toString().c_str());
}

void detenerAp() {
  dns.stop();
  WiFi.softAPdisconnect(true);
  WiFi.mode(WIFI_STA);
  apActivo = false;
  cambioReles = true;
  Serial.println("Red de emergencia apagada");
}

// La página solo responde a quien está conectado a la red de emergencia.
bool desdeAp() {
  if (apActivo && web.client().localIP() == WiFi.softAPIP()) return true;
  web.send(403, "text/plain", "Solo disponible desde la red de emergencia");
  return false;
}

void enviarJson(JsonDocument& doc, int codigo = 200) {
  String texto;
  serializeJson(doc, texto);
  web.send(codigo, "application/json", texto);
}

void responderError(const char* mensaje) {
  JsonDocument doc;
  doc["error"] = mensaje;
  enviarJson(doc, 400);
}

void apiEstado() {
  if (!desdeAp()) return;
  JsonDocument doc;
  reglas::Tiempo t = tiempoActual();
  doc["id"] = DISPOSITIVO;
  doc["hay_hora"] = t.hayHora;
  doc["epoch"] = t.epoch;
  doc["wifi"] = WiFi.status() == WL_CONNECTED;
  doc["servidor"] = mqtt.connected();
  doc["pendientes"] = bufCantidad;
  {
    Bloqueo b;
    doc["config_local"] = cfgLocal;
    if (cfgError[0]) doc["error_config"] = cfgError;
    for (int i = 0; i < lecturas.cantidad; i++) {
      if (t.uptimeS - lecturas.items[i].uptimeS <= reglas::MAX_EDAD_DATO_S)
        doc["lecturas"][lecturas.items[i].nombre] = lecturas.items[i].valor;
    }
    for (int i = 0; i < CANT_RELES; i++) {
      JsonObject r = doc["reles"][IDS[i]].to<JsonObject>();
      r["on"] = encendido[i];
      r["motivo"] = motivo[i];
    }
  }
  JsonDocument config;
  deserializeJson(config, cfgJson);
  doc["config"] = config;
  JsonObject r = doc["red"].to<JsonObject>();
  r["ssid"] = red.ssid;
  r["mqtt_host"] = red.mqttHost;
  r["mqtt_puerto"] = red.mqttPuerto;
  r["tls"] = red.tls;
  enviarJson(doc);
}

void apiConfig() {
  if (!desdeAp()) return;
  String cuerpo = web.arg("plain");
  if (!aplicarConfig(cuerpo.c_str(), cuerpo.length(), true)) {
    char error[96];
    {
      Bloqueo b;
      memcpy(error, cfgError, sizeof(error));
    }
    responderError(error);
    return;
  }
  JsonDocument ok;
  ok["ok"] = true;
  enviarJson(ok);
}

void apiHora() {
  if (!desdeAp()) return;
  JsonDocument doc;
  if (deserializeJson(doc, web.arg("plain")) || !doc["epoch"].is<int64_t>()) return responderError("falta epoch");
  struct timeval tv = {(time_t)doc["epoch"].as<int64_t>(), 0};
  settimeofday(&tv, nullptr);
  Serial.println("Hora ajustada desde el celular");
  JsonDocument ok;
  ok["ok"] = true;
  enviarJson(ok);
}

void apiRed() {
  if (!desdeAp()) return;
  JsonDocument doc;
  if (deserializeJson(doc, web.arg("plain"))) return responderError("JSON inválido");
  const char* ssid = doc["ssid"] | "";
  if (!*ssid) return responderError("falta el nombre de la red Wi-Fi");
  red.ssid = ssid;
  if (doc["clave"].is<const char*>() && *doc["clave"].as<const char*>()) red.clave = doc["clave"].as<const char*>();
  if (doc["mqtt_host"].is<const char*>()) red.mqttHost = doc["mqtt_host"].as<const char*>();
  red.mqttPuerto = doc["mqtt_puerto"] | red.mqttPuerto;
  if (doc["mqtt_clave"].is<const char*>() && *doc["mqtt_clave"].as<const char*>())
    red.mqttClave = doc["mqtt_clave"].as<const char*>();
  red.tls = doc["tls"] | red.tls;

  prefs.putString("ssid", red.ssid);
  prefs.putString("clave", red.clave);
  prefs.putString("mhost", red.mqttHost);
  prefs.putUShort("mport", red.mqttPuerto);
  prefs.putString("mclave", red.mqttClave);
  prefs.putBool("tls", red.tls);

  JsonDocument ok;
  ok["ok"] = true;
  enviarJson(ok);
  // Reconectar con los datos nuevos (sin cortar la red de emergencia).
  mqtt.disconnect();
  WiFi.disconnect(false);
  WiFi.begin(red.ssid.c_str(), red.clave.c_str());
  ultimoIntentoWifi = millis();
}

void configurarWeb() {
  web.on("/", HTTP_GET, [] {
    if (desdeAp()) web.send_P(200, "text/html; charset=utf-8", PAGINA_LOCAL);
  });
  web.on("/api/estado", HTTP_GET, apiEstado);
  web.on("/api/config", HTTP_POST, apiConfig);
  web.on("/api/hora", HTTP_POST, apiHora);
  web.on("/api/red", HTTP_POST, apiRed);
  web.onNotFound([] {  // portal cautivo: todo lo demás redirige a la página
    web.sendHeader("Location", String("http://") + WiFi.softAPIP().toString() + "/");
    web.send(302, "text/plain", "");
  });
  web.begin();
}

// ======================================================================
// setup / loop
// ======================================================================

void setup() {
  Serial.begin(115200);
  candado = xSemaphoreCreateMutex();

  for (int i = 0; i < CANT_RELES; i++) {
    IDS[i] = PINES[i].id;
    encendido[i] = false;
    motivo[i][0] = 0;
    escribirRele(i, false);  // primero el nivel, después salida: los relés no "pestañean"
    pinMode(PINES[i].pin, OUTPUT);
  }

  cargarPreferencias();

  setenv("TZ", ZONA_HORARIA, 1);
  tzset();
  configTzTime(ZONA_HORARIA, "pool.ntp.org", "time.google.com");

  dht.begin();
  Wire.begin(PIN_SDA, PIN_SCL);
  scd4x.begin(Wire, SCD41_I2C_ADDR_62);
  scd4x.stopPeriodicMeasurement();  // por si quedó midiendo de un arranque anterior
  delay(500);
  scdOk = scd4x.startPeriodicMeasurement() == 0;
  Serial.printf("SCD40: %s\n", scdOk ? "ok" : "NO ENCONTRADO");

  xTaskCreatePinnedToCore(tareaControl, "control", 6144, nullptr, 2, nullptr, 1);

  clienteTls.setCACert(CERTIFICADOS_RAIZ);
  clienteTls.setHandshakeTimeout(15);
  mqtt.setCallback(alRecibir);
  mqtt.setBufferSize(2048);
  mqtt.setSocketTimeout(10);

  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(false);  // la reconexión la manejamos nosotros (ver loop)
  if (!red.ssid.isEmpty()) WiFi.begin(red.ssid.c_str(), red.clave.c_str());
  ultimoIntentoWifi = millis();

  configurarWeb();
}

void loop() {
  unsigned long ahora = millis();
  // Si hay alguien usando la red de emergencia, no intentamos reconectar:
  // buscar el Wi-Fi hace cambiar de canal a la placa y corta al celular.
  bool alguienEnAp = apActivo && WiFi.softAPgetStationNum() > 0;

  if (WiFi.status() != WL_CONNECTED && !alguienEnAp && !red.ssid.isEmpty() && ahora - ultimoIntentoWifi > 20000) {
    ultimoIntentoWifi = ahora;
    WiFi.disconnect(false);
    WiFi.begin(red.ssid.c_str(), red.clave.c_str());
  }

  if (WiFi.status() == WL_CONNECTED && !mqtt.connected() && !alguienEnAp && ahora - ultimoIntentoMqtt > 10000) {
    ultimoIntentoMqtt = ahora;
    conectarMqtt();
  }

  if (mqtt.connected()) {
    ultimoMqttOk = millis();
    mqtt.loop();
    vaciarBuffer();
    if (cambioReles || millis() - ultimoReporte > 60000) {
      cambioReles = false;
      ultimoReporte = millis();
      reportarReles();
    }
  }

  // Mediciones cada 30 s: al servidor si hay conexión, si no a la memoria.
  if (millis() - ultimaTelemetria > 30000) {
    ultimaTelemetria = millis();
    Muestra m = tomarMuestra();
    if (!mqtt.connected() || !publicarMuestra(m)) guardarEnBuffer(m);
  }

  // Red de emergencia: se prende tras AP_TRAS_MS sin servidor y se apaga
  // cuando la conexión lleva 1 minuto estable y nadie la está usando.
  bool sinServidor = !mqtt.connected() && millis() - ultimoMqttOk > AP_TRAS_MS;
  if (!apActivo && (sinServidor || red.ssid.isEmpty())) iniciarAp();
  if (apActivo && mqtt.connected() && millis() - conectadoDesde > 60000 && !alguienEnAp) detenerAp();

  if (apActivo) dns.processNextRequest();
  web.handleClient();
  delay(5);
}
