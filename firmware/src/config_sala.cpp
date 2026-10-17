#include "config_sala.h"

#include <stdio.h>
#include <string.h>

using reglas::ConfigRele;
using reglas::Regla;
using reglas::Tipo;

bool parsearHora(const char* texto, int16_t& minutos) {
  if (!texto) return false;
  int h, m;
  char resto;
  if (sscanf(texto, "%d:%d%c", &h, &m, &resto) != 2) return false;
  if (h < 0 || h > 23 || m < 0 || m > 59) return false;
  minutos = (int16_t)(h * 60 + m);
  return true;
}

#define FALLA(...)                                  \
  do {                                              \
    snprintf(error, largoError, __VA_ARGS__);       \
    return false;                                   \
  } while (0)

static bool parsearRegla(JsonObjectConst j, const char* id, Regla& r, char* error, size_t largoError) {
  const char* tipo = j["tipo"] | "";
  if (strcmp(tipo, "horario") == 0) {
    r.tipo = Tipo::Horario;
    if (!parsearHora(j["encender"], r.desdeMin) || !parsearHora(j["apagar"], r.hastaMin))
      FALLA("%s: horario con hora inválida", id);
  } else if (strcmp(tipo, "umbral") == 0) {
    r.tipo = Tipo::Umbral;
    const char* variable = j["variable"] | "";
    if (!*variable) FALLA("%s: falta la variable", id);
    snprintf(r.variable, sizeof(r.variable), "%s", variable);
    const char* si = j["encender_si"] | "";
    if (strcmp(si, "mayor") != 0 && strcmp(si, "menor") != 0) FALLA("%s: encender_si debe ser mayor o menor", id);
    r.encenderSiMayor = strcmp(si, "mayor") == 0;
    if (!j["valor"].is<float>()) FALLA("%s: falta el valor del umbral", id);
    r.valor = j["valor"];
    r.histeresis = j["histeresis"] | 0.0f;
    if (r.histeresis < 0) FALLA("%s: la histéresis no puede ser negativa", id);
  } else if (strcmp(tipo, "pulsos") == 0) {
    r.tipo = Tipo::Pulsos;
    long encendido = j["encendido_s"] | 0L;
    long cada = j["cada_min"] | 0L;
    if (encendido <= 0 || cada <= 0 || cada > 1440) FALLA("%s: pulsos con tiempos inválidos", id);
    if (encendido > cada * 60) FALLA("%s: el pulso dura más que el período", id);
    r.encendidoS = (uint32_t)encendido;
    r.cadaMin = (uint32_t)cada;
    r.desdeMin = r.hastaMin = 0;  // sin ventana = todo el día
    if (!j["desde"].isNull() || !j["hasta"].isNull()) {
      if (!parsearHora(j["desde"], r.desdeMin) || !parsearHora(j["hasta"], r.hastaMin))
        FALLA("%s: ventana de pulsos inválida", id);
    }
  } else {
    FALLA("%s: tipo de regla desconocido '%s'", id, tipo);
  }
  return true;
}

bool parsearConfig(JsonVariantConst json, const char* const ids[], int cantidad, ConfigSala& salida,
                   char* error, size_t largoError) {
  if (!json.is<JsonObjectConst>()) FALLA("la configuración no es un objeto JSON");
  JsonObjectConst reles = json["reles"];
  if (reles.isNull()) FALLA("falta 'reles'");

  ConfigSala nueva;
  nueva.version = json["version"] | 0;
  nueva.cantidad = cantidad > reglas::MAX_RELES ? reglas::MAX_RELES : cantidad;

  for (int i = 0; i < nueva.cantidad; i++) {
    ConfigRele& c = nueva.reles[i];
    snprintf(c.id, sizeof(c.id), "%s", ids[i]);
    JsonObjectConst j = reles[ids[i]];
    if (j.isNull()) {  // no configurado: apagado por seguridad
      c.manual = true;
      c.manualEstado = false;
      continue;
    }
    const char* modo = j["modo"] | "auto";
    if (strcmp(modo, "auto") != 0 && strcmp(modo, "manual") != 0) FALLA("%s: modo inválido", ids[i]);
    c.manual = strcmp(modo, "manual") == 0;
    c.manualEstado = j["manual_estado"] | false;
    c.manualHasta = j["manual_hasta"] | (int64_t)0;
    if (!parsearRegla(j["regla"], ids[i], c.regla, error, largoError)) return false;
  }

  salida = nueva;
  return true;
}
