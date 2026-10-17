// Pruebas del motor de reglas, corren en la computadora (no hace falta el ESP32):
//   cd firmware && pio test -e native
#include <string.h>
#include <unity.h>

#include "../../src/config_sala.h"
#include "../../src/reglas.h"

using namespace reglas;

static const char* IDS[] = {"riego", "humidificador", "deshumidificador", "luz"};

static Tiempo hora(int h, int m, int s = 0) {
  Tiempo t;
  t.hayHora = true;
  t.segundosDelDia = h * 3600 + m * 60 + s;
  t.epoch = 1800000000 + t.segundosDelDia;
  t.uptimeS = 100000;
  return t;
}

static Lecturas conDpv(float dpv, uint32_t edadS = 0) {
  Lecturas l;
  l.poner("dpv", dpv, 100000 - edadS);
  return l;
}

static ConfigSala cargar(const char* json) {
  JsonDocument doc;
  TEST_ASSERT_FALSE(deserializeJson(doc, json));
  ConfigSala c;
  char error[96] = "";
  bool ok = parsearConfig(doc.as<JsonVariantConst>(), IDS, 4, c, error, sizeof(error));
  TEST_ASSERT_TRUE_MESSAGE(ok, error);
  return c;
}

static bool configInvalida(const char* json) {
  JsonDocument doc;
  deserializeJson(doc, json);
  ConfigSala c;
  char error[96];
  return !parsearConfig(doc.as<JsonVariantConst>(), IDS, 4, c, error, sizeof(error));
}

static const char* CONFIG = R"({"version": 7, "reles": {
  "riego": {"modo": "auto", "regla": {"tipo": "pulsos", "encendido_s": 30, "cada_min": 120,
                                       "desde": "08:00", "hasta": "20:00"}},
  "humidificador": {"modo": "auto", "regla": {"tipo": "umbral", "variable": "dpv",
                    "encender_si": "mayor", "valor": 1.2, "histeresis": 0.1}},
  "deshumidificador": {"modo": "auto", "regla": {"tipo": "umbral", "variable": "dpv",
                       "encender_si": "menor", "valor": 0.8, "histeresis": 0.1}},
  "luz": {"modo": "auto", "regla": {"tipo": "horario", "encender": "18:00", "apagar": "06:00"}}
}})";

// ------------------------------------------------------------------ horario

void test_horario_cruza_medianoche() {
  ConfigSala c = cargar(CONFIG);
  Lecturas l;
  TEST_ASSERT_TRUE(decidir(c.reles[3], hora(23, 0), l, false).encendido);
  TEST_ASSERT_TRUE(decidir(c.reles[3], hora(5, 59), l, false).encendido);
  TEST_ASSERT_FALSE(decidir(c.reles[3], hora(6, 0), l, false).encendido);
  TEST_ASSERT_FALSE(decidir(c.reles[3], hora(12, 0), l, false).encendido);
}

void test_horario_sin_hora_apaga() {
  ConfigSala c = cargar(CONFIG);
  Tiempo t;  // hayHora = false
  Lecturas l;
  TEST_ASSERT_FALSE(decidir(c.reles[3], t, l, true).encendido);
}

// --------------------------------------------------------------- DPV umbral

void test_humidificador_prende_con_dpv_alto() {
  ConfigSala c = cargar(CONFIG);
  const ConfigRele& hum = c.reles[1];
  TEST_ASSERT_TRUE(decidir(hum, hora(12, 0), conDpv(1.35), false).encendido);
  TEST_ASSERT_TRUE(decidir(hum, hora(12, 0), conDpv(1.15), true).encendido);    // histéresis
  TEST_ASSERT_FALSE(decidir(hum, hora(12, 0), conDpv(1.15), false).encendido);  // histéresis
  TEST_ASSERT_FALSE(decidir(hum, hora(12, 0), conDpv(1.05), true).encendido);
}

void test_deshumidificador_prende_con_dpv_bajo() {
  ConfigSala c = cargar(CONFIG);
  const ConfigRele& des = c.reles[2];
  TEST_ASSERT_TRUE(decidir(des, hora(12, 0), conDpv(0.7), false).encendido);
  TEST_ASSERT_TRUE(decidir(des, hora(12, 0), conDpv(0.85), true).encendido);
  TEST_ASSERT_FALSE(decidir(des, hora(12, 0), conDpv(0.95), true).encendido);
}

void test_nunca_humidificador_y_deshumidificador_juntos() {
  ConfigSala c = cargar(CONFIG);
  for (float dpv = 0.3f; dpv < 2.0f; dpv += 0.01f) {
    bool h = decidir(c.reles[1], hora(12, 0), conDpv(dpv), false).encendido;
    bool d = decidir(c.reles[2], hora(12, 0), conDpv(dpv), false).encendido;
    TEST_ASSERT_FALSE(h && d);
  }
}

void test_dato_viejo_apaga() {
  ConfigSala c = cargar(CONFIG);
  Decision d = decidir(c.reles[1], hora(12, 0), conDpv(1.8, MAX_EDAD_DATO_S + 1), true);
  TEST_ASSERT_FALSE(d.encendido);
  TEST_ASSERT_NOT_NULL(strstr(d.motivo, "sin datos"));
}

// ------------------------------------------------------------------- pulsos

void test_pulsos_dentro_de_la_ventana() {
  ConfigSala c = cargar(CONFIG);
  const ConfigRele& riego = c.reles[0];
  Lecturas l;
  TEST_ASSERT_TRUE(decidir(riego, hora(8, 0, 0), l, false).encendido);
  TEST_ASSERT_TRUE(decidir(riego, hora(8, 0, 29), l, false).encendido);
  TEST_ASSERT_FALSE(decidir(riego, hora(8, 0, 30), l, false).encendido);
  TEST_ASSERT_TRUE(decidir(riego, hora(10, 0, 5), l, false).encendido);   // 2 h después
  TEST_ASSERT_FALSE(decidir(riego, hora(11, 0, 0), l, false).encendido);
  TEST_ASSERT_FALSE(decidir(riego, hora(22, 0, 0), l, false).encendido);  // fuera de ventana
  TEST_ASSERT_FALSE(decidir(riego, hora(7, 59, 59), l, false).encendido);
}

void test_pulsos_sin_hora_cuentan_desde_el_arranque() {
  ConfigSala c = cargar(CONFIG);
  Lecturas l;
  Tiempo t;
  t.uptimeS = 2 * 7200 + 10;  // 10 s dentro del tercer pulso
  TEST_ASSERT_TRUE(decidir(c.reles[0], t, l, false).encendido);
  t.uptimeS = 2 * 7200 + 31;
  TEST_ASSERT_FALSE(decidir(c.reles[0], t, l, false).encendido);
}

// ------------------------------------------------------------------- manual

void test_manual_con_vencimiento() {
  ConfigSala c = cargar(CONFIG);
  ConfigRele riego = c.reles[0];
  Lecturas l;
  Tiempo t = hora(15, 0);  // fuera de pulso
  riego.manual = true;
  riego.manualEstado = true;
  riego.manualHasta = t.epoch + 600;
  TEST_ASSERT_TRUE(decidir(riego, t, l, false).encendido);
  riego.manualHasta = t.epoch - 1;  // venció -> vuelve a la regla
  TEST_ASSERT_FALSE(decidir(riego, t, l, true).encendido);
}

void test_manual_con_limite_sin_hora_no_se_aplica() {
  ConfigSala c = cargar(CONFIG);
  ConfigRele riego = c.reles[0];
  riego.manual = true;
  riego.manualEstado = true;
  riego.manualHasta = 1800000000;
  Tiempo t;  // sin hora
  t.uptimeS = 3000;  // fuera de pulso
  Lecturas l;
  TEST_ASSERT_FALSE(decidir(riego, t, l, false).encendido);
}

// ------------------------------------------------------------------ parseo

void test_rele_ausente_queda_apagado() {
  ConfigSala c = cargar(R"({"reles": {}})");
  Lecturas l;
  for (int i = 0; i < 4; i++) TEST_ASSERT_FALSE(decidir(c.reles[i], hora(12, 0), l, true).encendido);
}

void test_configs_invalidas() {
  TEST_ASSERT_TRUE(configInvalida("[]"));
  TEST_ASSERT_TRUE(configInvalida(R"({"reles": {"luz": {"regla": {"tipo": "horario", "encender": "25:00", "apagar": "06:00"}}}})"));
  TEST_ASSERT_TRUE(configInvalida(R"({"reles": {"riego": {"regla": {"tipo": "pulsos", "encendido_s": 600, "cada_min": 5}}}})"));
  TEST_ASSERT_TRUE(configInvalida(R"({"reles": {"riego": {"regla": {"tipo": "magia"}}}})"));
  TEST_ASSERT_TRUE(configInvalida(R"({"reles": {"luz": {"modo": "turbo", "regla": {"tipo": "horario", "encender": "06:00", "apagar": "18:00"}}}})"));
}

void test_valor_entero_y_version() {
  ConfigSala c = cargar(R"({"version": 9, "reles": {"humidificador": {"regla": {"tipo": "umbral",
      "variable": "humedad", "encender_si": "menor", "valor": 55}}}})");
  TEST_ASSERT_EQUAL(9, c.version);
  TEST_ASSERT_EQUAL_FLOAT(55.0f, c.reles[1].regla.valor);
}

void test_dpv() {
  TEST_ASSERT_FLOAT_WITHIN(0.01f, 1.27f, calcularDpv(25.0f, 60.0f));
}

void setUp() {}
void tearDown() {}

int main() {
  UNITY_BEGIN();
  RUN_TEST(test_horario_cruza_medianoche);
  RUN_TEST(test_horario_sin_hora_apaga);
  RUN_TEST(test_humidificador_prende_con_dpv_alto);
  RUN_TEST(test_deshumidificador_prende_con_dpv_bajo);
  RUN_TEST(test_nunca_humidificador_y_deshumidificador_juntos);
  RUN_TEST(test_dato_viejo_apaga);
  RUN_TEST(test_pulsos_dentro_de_la_ventana);
  RUN_TEST(test_pulsos_sin_hora_cuentan_desde_el_arranque);
  RUN_TEST(test_manual_con_vencimiento);
  RUN_TEST(test_manual_con_limite_sin_hora_no_se_aplica);
  RUN_TEST(test_rele_ausente_queda_apagado);
  RUN_TEST(test_configs_invalidas);
  RUN_TEST(test_valor_entero_y_version);
  RUN_TEST(test_dpv);
  return UNITY_END();
}
