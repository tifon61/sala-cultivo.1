# Salas de cultivo

Este sistema administra **dos salas de cultivo**. Cada sala tiene un módulo ESP32 con un DHT11, un SCD40 y 4 relés. Las salas están en un lugar distinto del servidor, y todo se maneja desde el celular o la notebook estés donde estés.

- **Esquema de las dos salas:** variables, equipos prendidos o apagados, cuándo cambia la luz y cuánto falta para el próximo riego.
- **Reglas automáticas** que corre cada ESP32, **aunque se corte internet**:
  - riego por pulsos de tiempo;
  - humidificador y deshumidificador por DPV;
  - luz por horario.
- **Control manual**, sin límite o por un tiempo.
- **Bitácora** de cada sala: cambios de etapa (con día y semana de floración o vegetativo), riegos con nutrientes, podas, cosecha…
- **Red de emergencia:** si el módulo pierde contacto con el servidor, crea su propio Wi-Fi para configurarlo en el lugar.
- **Gráficos históricos** de cada sala.

```
  CASA (servidor Ubuntu)                                LUGAR DE LAS SALAS
 ┌──────────────────────────────────────┐              ┌──────────────────────┐
 │ docker compose "sala-cultivo"        │   internet   │ ESP32 sala1  ESP32 sala2
 │  mosquitto :1883 ◄── Tailscale Funnel│◄─MQTT+TLS───│ DHT11, SCD40, 4 relés │
 │  backend   :8090 (web + API)         │   :8443      │ (si se corta: red     │
 │  postgres  (interno)                 │              │  "Cultivo-salaN")     │
 └──────────────▲───────────────────────┘              └──────────────────────┘
                │ Tailscale (privado)
        celular / notebook, desde cualquier lugar
```

- 🛠️ **Instalación paso a paso** (todo se puede hacer remoto por SSH): [`docs/INSTALACION.md`](docs/INSTALACION.md)
- 📚 **Cómo funciona cada parte, para aprender:** [`docs/COMO_FUNCIONA.md`](docs/COMO_FUNCIONA.md)

## Estructura

| Carpeta | Qué hay |
|---|---|
| `docker-compose.yml`, `.env.example` | Los 3 servicios del servidor y sus claves |
| `mosquitto/` | Broker MQTT: usuarios y permisos (ACL) |
| `backend/app/` | API, conexión con los módulos, base de datos, validación de reglas |
| `frontend/` | La página (esquema, equipos, gráficos, bitácora) |
| `config/salas.yaml` | Salas, relés y reglas iniciales |
| `firmware/` | Programa de los ESP32 (PlatformIO), con sus pruebas |
| `index.html` (raíz) | El dashboard viejo de ThingSpeak. No se tocó. |

## Hardware de cada módulo

| Qué | Pin | Notas |
|---|---|---|
| ESP32 DevKit | — | |
| DHT11 (temperatura y humedad) | GPIO4 | Con una resistencia de 10 kΩ entre DATA y 3V3 si el módulo no la trae |
| SCD40 (CO₂, más temperatura y humedad) | SDA 21, SCL 22 | Alimentado con 3V3 |
| Relé 1: bomba de riego | GPIO26 | |
| Relé 2: humidificador | GPIO27 | |
| Relé 3: deshumidificador | GPIO25 | |
| Relé 4: luz | GPIO33 | Si el cuarto relé es otra cosa, se cambia en `config.h` y `salas.yaml` |

> ⚠️ **Sobre el DHT11:** mide la temperatura con ±2 °C de error y la humedad con ±5 %, en números enteros. Para controlar el DPV es poco preciso. Si el DHT11 falla, el módulo calcula el DPV con el SCD40. Un SHT31 o SHT40 cuesta poco más y es mucho mejor; cambiarlo es un ajuste chico en el firmware.

## Pruebas

```bash
cd backend && python3 -m venv .venv && .venv/bin/pip install -r requirements.txt pytest && .venv/bin/pytest
cd firmware && pio test -e native        # motor de reglas del ESP32, corre en la PC
```
