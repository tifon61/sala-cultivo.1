// Copiá este archivo como config.h (uno por placa) y completá tus datos:
//   cp include/config.example.h include/config.h
// config.h no se sube a git porque tiene contraseñas.
//
// Wi-Fi y servidor también se pueden cambiar después desde la red de
// emergencia del ESP32 (sin volver a programarlo). Lo de acá es el valor inicial.
#pragma once

// --- Identidad -------------------------------------------------------------
// "sala1" o "sala2". También es el USUARIO MQTT de esta placa (el broker solo
// le deja tocar los tópicos cultivo/<su-id>/...).
#define DISPOSITIVO    "sala1"

// --- Wi-Fi del lugar donde está la sala -------------------------------------
#define WIFI_SSID      "wifi-de-la-sala"
#define WIFI_CLAVE     "clave-wifi"

// --- Servidor (a través de Tailscale Funnel, ver README) -------------------
#define MQTT_HOST      "servidor.tu-tailnet.ts.net"
#define MQTT_PUERTO    8443
#define MQTT_TLS       true                // false solo para pruebas en la red local
#define MQTT_CLAVE     "clave-de-sala1"    // la de sala1 en MQTT_SALAS del .env

// --- Red de emergencia -------------------------------------------------------
// Si pasa AP_TRAS_MS sin poder hablar con el servidor, la placa crea la red
// "Cultivo-<DISPOSITIVO>" con esta clave (mínimo 8 caracteres).
// Conectate con el celular y entrá a http://192.168.4.1
#define AP_CLAVE       "cambiame123"
#define AP_TRAS_MS     (2UL * 60UL * 1000UL)

// --- Hora --------------------------------------------------------------------
// Zona horaria en formato POSIX. Argentina: "<-03>3". México (centro): "CST6".
// España: "CET-1CEST,M3.5.0,M10.5.0/3". Chile: "<-04>4<-03>,M9.1.6/24,M4.1.6/24"
#define ZONA_HORARIA   "<-03>3"

// --- Sensores ----------------------------------------------------------------
#define PIN_DHT        4                   // DHT: temperatura y humedad
#define TIPO_DHT       DHT22               // DHT11 o DHT22, según el sensor que tenga ESTA placa
#define PIN_SDA        21                  // SCD40: CO2 (+ temperatura2 y humedad2)
#define PIN_SCL        22

// --- Relés -------------------------------------------------------------------
// id (igual que en config/salas.yaml del servidor) y pin GPIO.
// Pines elegidos porque no afectan el arranque del ESP32: 25, 26, 27, 32, 33.
#define RELES { \
    {"riego",            26}, \
    {"humidificador",    27}, \
    {"deshumidificador", 25}, \
    {"luz",              33}, \
}
// La mayoría de los módulos de 4 relés se activan con nivel BAJO.
#define RELE_ACTIVO_BAJO true

// Configuración que usa la placa la primera vez, antes de hablar con el servidor.
// Después se reemplaza por la del servidor (o la que cargues en la red de emergencia).
static const char CONFIG_INICIAL[] = R"({"version": 0, "reles": {
  "riego":            {"modo": "auto", "regla": {"tipo": "pulsos", "encendido_s": 20, "cada_min": 180, "desde": "08:00", "hasta": "20:00"}},
  "humidificador":    {"modo": "auto", "regla": {"tipo": "umbral", "variable": "dpv", "encender_si": "mayor", "valor": 1.2, "histeresis": 0.1}},
  "deshumidificador": {"modo": "auto", "regla": {"tipo": "umbral", "variable": "dpv", "encender_si": "menor", "valor": 0.8, "histeresis": 0.1}},
  "luz":              {"modo": "auto", "regla": {"tipo": "horario", "encender": "06:00", "apagar": "00:00"}}
}})";
