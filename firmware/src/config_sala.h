// Configuración de la sala en formato JSON: la misma que manda el servidor
// y la que se edita desde la página local del ESP32. Ejemplo:
//
// {"version": 3, "reles": {
//    "riego": {"modo": "auto", "regla": {"tipo": "pulsos", "encendido_s": 30,
//              "cada_min": 120, "desde": "08:00", "hasta": "20:00"}},
//    "humidificador": {"modo": "manual", "manual_estado": true, "manual_hasta": 1792250000,
//              "regla": {"tipo": "umbral", "variable": "dpv", "encender_si": "mayor",
//                        "valor": 1.2, "histeresis": 0.1}}, ...}}
#pragma once

#include <ArduinoJson.h>

#include "reglas.h"

struct ConfigSala {
  int32_t version = 0;
  int cantidad = 0;
  reglas::ConfigRele reles[reglas::MAX_RELES];
};

// Llena `salida` con los relés `ids` (los que existen físicamente en la placa).
// Un relé que no aparece en el JSON queda en manual apagado.
// Si algo es inválido devuelve false, escribe el motivo en `error` y no toca `salida`.
bool parsearConfig(JsonVariantConst json, const char* const ids[], int cantidad, ConfigSala& salida,
                   char* error, size_t largoError);

// "08:30" -> 510. Devuelve false si el formato no es HH:MM válido.
bool parsearHora(const char* texto, int16_t& minutos);
