// Copiá este archivo como config.h y completá tus datos:
//   cp include/config.example.h include/config.h
// config.h no se sube a git porque tiene contraseñas.
#pragma once

// --- Wi-Fi de casa --------------------------------------------------------
#define WIFI_SSID      "mi-wifi"
#define WIFI_CLAVE     "clave-wifi"

// --- Broker MQTT (el servidor casero, IP de la red LOCAL, no la de Tailscale)
#define MQTT_HOST      "192.168.1.50"
#define MQTT_PUERTO    1883
#define MQTT_USUARIO   "esp32"            // MQTT_USUARIO_ESP32 del .env
#define MQTT_CLAVE     "cambiame-esp32"   // MQTT_CLAVE_ESP32 del .env

// Tiene que coincidir con DISPOSITIVO del .env
#define DISPOSITIVO    "sala1"

// --- Sensores (comentá el #define de lo que no tengas) ------------------
#define USAR_SHT31         // temperatura + humedad (I2C, dirección 0x44)
#define USAR_SCD4X         // CO2 + temperatura2 + humedad2 (SCD40/SCD41, I2C 0x62)
#define USAR_SUELO         // humedad de suelo capacitiva (analógica)

#define PIN_SDA        21
#define PIN_SCL        22

// Sensor de suelo: usar pines de ADC1 (32-39). Los de ADC2 no funcionan con Wi-Fi.
#define PIN_SUELO1     34
// Calibración: lectura cruda con el sensor al aire (seco) y en un vaso de agua (mojado).
#define SUELO_SECO     3000
#define SUELO_MOJADO   1300

#define INTERVALO_TELEMETRIA_MS  30000

// --- Relés ----------------------------------------------------------------
// id (igual que en config/sala.yaml), pin GPIO, y estado "seguro" que se aplica
// al arrancar y si se pierde contacto con el servidor.
// Pines elegidos porque no afectan el arranque del ESP32: 25, 26, 27, 32, 33.
#define RELES { \
    {"luz",           26, false}, \
    {"extractor",     27, false}, \
    {"humidificador", 25, false}, \
    {"riego",         33, false}, \
}

// La mayoría de los módulos de relés de 4/8 canales se activan con nivel BAJO.
#define RELE_ACTIVO_BAJO true

// Si no llega ninguna orden del servidor en este tiempo -> modo seguro.
#define FAILSAFE_MS    (5UL * 60UL * 1000UL)
