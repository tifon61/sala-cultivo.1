// Motor de reglas de los relés.
//
// Este archivo es C++ "puro": no usa nada de Arduino. Así se puede compilar y
// probar en la computadora (pio test -e native) además de correr en el ESP32.
//
// El ESP32 evalúa estas reglas SIEMPRE, con o sin conexión. El servidor solo
// le manda la configuración; si se corta internet, la sala sigue funcionando
// con la última configuración recibida.
#pragma once

#include <stdint.h>
#include <stddef.h>

namespace reglas {

const int MAX_RELES = 4;
const int MAX_LECTURAS = 8;
const uint32_t MAX_EDAD_DATO_S = 180;  // un dato más viejo que esto no se usa

enum class Tipo : uint8_t { Horario, Umbral, Pulsos };

struct Regla {
  Tipo tipo = Tipo::Horario;
  // Horario: encender/apagar. Pulsos: ventana del día en que se permite regar.
  // En minutos desde medianoche; desde == hasta significa "todo el día".
  int16_t desdeMin = 0;
  int16_t hastaMin = 0;
  // Umbral
  char variable[16] = "dpv";
  bool encenderSiMayor = true;
  float valor = 0;
  float histeresis = 0;
  // Pulsos: encendido "encendidoS" segundos cada "cadaMin" minutos.
  uint32_t encendidoS = 0;
  uint32_t cadaMin = 0;
};

struct ConfigRele {
  char id[16] = "";
  bool manual = false;        // false = automático
  bool manualEstado = false;
  int64_t manualHasta = 0;    // epoch UTC; 0 = sin límite
  Regla regla;
};

// Qué sabe el ESP32 del tiempo en este momento.
struct Tiempo {
  bool hayHora = false;       // false si nunca pudo sincronizar el reloj
  int64_t epoch = 0;          // segundos UTC
  int32_t segundosDelDia = 0; // hora LOCAL, 0..86399
  uint32_t uptimeS = 0;       // segundos desde que arrancó
};

struct Lecturas {
  struct Item {
    char nombre[16];
    float valor;
    uint32_t uptimeS;  // cuándo se midió
  };
  Item items[MAX_LECTURAS];
  int cantidad = 0;

  void poner(const char* nombre, float valor, uint32_t uptimeS);
  void invalidar(const char* nombre);
  // true si existe y no es más vieja que MAX_EDAD_DATO_S
  bool buscar(const char* nombre, uint32_t ahoraUptimeS, float& valor) const;
};

struct Decision {
  bool encendido = false;
  char motivo[72] = "";
};

bool enVentana(int32_t segundosDelDia, int16_t desdeMin, int16_t hastaMin);

Decision evaluarRegla(const Regla& r, const Tiempo& t, const Lecturas& l, bool encendidoActual);
Decision decidir(const ConfigRele& c, const Tiempo& t, const Lecturas& l, bool encendidoActual);

// Déficit de presión de vapor en kPa (fórmula de Tetens).
float calcularDpv(float tempC, float humedadRel);

}  // namespace reglas
