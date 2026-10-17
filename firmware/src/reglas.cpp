#include "reglas.h"

#include <math.h>
#include <stdarg.h>
#include <stdio.h>
#include <string.h>

namespace reglas {

// ------------------------------------------------------------------ lecturas

void Lecturas::poner(const char* nombre, float valor, uint32_t uptimeS) {
  for (int i = 0; i < cantidad; i++) {
    if (strcmp(items[i].nombre, nombre) == 0) {
      items[i].valor = valor;
      items[i].uptimeS = uptimeS;
      return;
    }
  }
  if (cantidad >= MAX_LECTURAS) return;
  Item& it = items[cantidad++];
  snprintf(it.nombre, sizeof(it.nombre), "%s", nombre);
  it.valor = valor;
  it.uptimeS = uptimeS;
}

void Lecturas::invalidar(const char* nombre) {
  for (int i = 0; i < cantidad; i++) {
    if (strcmp(items[i].nombre, nombre) == 0) {
      items[i] = items[--cantidad];
      return;
    }
  }
}

bool Lecturas::buscar(const char* nombre, uint32_t ahoraUptimeS, float& valor) const {
  for (int i = 0; i < cantidad; i++) {
    if (strcmp(items[i].nombre, nombre) == 0) {
      if (ahoraUptimeS - items[i].uptimeS > MAX_EDAD_DATO_S) return false;
      valor = items[i].valor;
      return true;
    }
  }
  return false;
}

// ------------------------------------------------------------------- helpers

static Decision decision(bool encendido, const char* formato, ...) {
  Decision d;
  d.encendido = encendido;
  va_list args;
  va_start(args, formato);
  vsnprintf(d.motivo, sizeof(d.motivo), formato, args);
  va_end(args);
  return d;
}

bool enVentana(int32_t segundosDelDia, int16_t desdeMin, int16_t hastaMin) {
  if (desdeMin == hastaMin) return true;  // todo el día
  int32_t desde = desdeMin * 60, hasta = hastaMin * 60;
  if (desde < hasta) return segundosDelDia >= desde && segundosDelDia < hasta;
  return segundosDelDia >= desde || segundosDelDia < hasta;  // cruza medianoche
}

// --------------------------------------------------------------------- reglas

static Decision evaluarHorario(const Regla& r, const Tiempo& t) {
  if (!t.hayHora) return decision(false, "horario: sin hora, apagado");
  bool dentro = enVentana(t.segundosDelDia, r.desdeMin, r.hastaMin);
  return decision(dentro, "horario %02d:%02d-%02d:%02d: %s", r.desdeMin / 60, r.desdeMin % 60,
                  r.hastaMin / 60, r.hastaMin % 60, dentro ? "dentro" : "fuera");
}

static Decision evaluarUmbral(const Regla& r, const Tiempo& t, const Lecturas& l, bool actual) {
  float v;
  if (!l.buscar(r.variable, t.uptimeS, v)) {
    // Sin datos frescos no sabemos qué pasa: lo seguro es apagar.
    return decision(false, "sin datos recientes de %s", r.variable);
  }
  if (r.encenderSiMayor) {
    if (v > r.valor) return decision(true, "%s %.2f > %.2f", r.variable, v, r.valor);
    if (v < r.valor - r.histeresis) return decision(false, "%s %.2f < %.2f", r.variable, v, r.valor - r.histeresis);
  } else {
    if (v < r.valor) return decision(true, "%s %.2f < %.2f", r.variable, v, r.valor);
    if (v > r.valor + r.histeresis) return decision(false, "%s %.2f > %.2f", r.variable, v, r.valor + r.histeresis);
  }
  // Entre el umbral y el umbral ± histéresis: se mantiene lo que estaba.
  return decision(actual, "%s %.2f en histéresis, se mantiene", r.variable, v);
}

static Decision evaluarPulsos(const Regla& r, const Tiempo& t) {
  if (r.cadaMin == 0 || r.encendidoS == 0) return decision(false, "pulsos: sin configurar");
  uint32_t periodo = r.cadaMin * 60;
  uint32_t transcurrido;

  if (t.hayHora) {
    if (!enVentana(t.segundosDelDia, r.desdeMin, r.hastaMin)) {
      return decision(false, "pulsos: fuera de la ventana de riego");
    }
    // Los pulsos se cuentan desde el inicio de la ventana: con ventana 08:00
    // y cada 120 min, riega a las 08:00, 10:00, 12:00...
    transcurrido = (uint32_t)((t.segundosDelDia - r.desdeMin * 60 + 86400) % 86400);
  } else {
    // Sin reloj no hay ventana: contamos desde que arrancó la placa.
    // Es preferible regar a cualquier hora a no regar durante días.
    transcurrido = t.uptimeS;
  }

  uint32_t enPeriodo = transcurrido % periodo;
  if (enPeriodo < r.encendidoS) {
    return decision(true, "pulso: %us de %us cada %u min%s", (unsigned)enPeriodo, (unsigned)r.encendidoS,
                    (unsigned)r.cadaMin, t.hayHora ? "" : " (sin hora)");
  }
  uint32_t faltan = (periodo - enPeriodo) / 60;
  return decision(false, "pulsos: próximo en %u min%s", (unsigned)faltan + 1, t.hayHora ? "" : " (sin hora)");
}

Decision evaluarRegla(const Regla& r, const Tiempo& t, const Lecturas& l, bool encendidoActual) {
  switch (r.tipo) {
    case Tipo::Horario: return evaluarHorario(r, t);
    case Tipo::Umbral: return evaluarUmbral(r, t, l, encendidoActual);
    case Tipo::Pulsos: return evaluarPulsos(r, t);
  }
  return decision(false, "regla desconocida");
}

Decision decidir(const ConfigRele& c, const Tiempo& t, const Lecturas& l, bool encendidoActual) {
  if (c.manual) {
    const char* accion = c.manualEstado ? "encendido" : "apagado";
    if (c.manualHasta == 0) return decision(c.manualEstado, "manual: %s", accion);
    if (t.hayHora && t.epoch < c.manualHasta) {
      int32_t faltan = (int32_t)((c.manualHasta - t.epoch + 59) / 60);
      return decision(c.manualEstado, "manual: %s (%d min más)", accion, (int)faltan);
    }
    // Venció, o no hay hora para saber si venció: vuelve a la regla automática.
    // (Un riego manual sin poder vencer podría inundar la sala.)
  }
  return evaluarRegla(c.regla, t, l, encendidoActual);
}

float calcularDpv(float tempC, float humedadRel) {
  float saturacion = 0.61078f * expf(17.27f * tempC / (tempC + 237.3f));
  return saturacion * (1.0f - humedadRel / 100.0f);
}

}  // namespace reglas
