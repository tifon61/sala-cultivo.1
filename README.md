# Sala de cultivo

Este sistema administra una sala de cultivo con un ESP32. Registra las mediciones de los sensores, muestra gráficos y controla los relés (luz, extractor, humidificador y riego) en modo automático o manual desde el celular, por Tailscale.

Corre en un Docker Compose propio, separado del sistema meteorológico, y no usa los puertos 8080, 8081 ni 5432.

```
 ESP32 (Wi-Fi de casa)                     Servidor Ubuntu (Docker Compose "sala-cultivo")
 ┌──────────────────┐   MQTT :1883    ┌───────────┐      ┌─────────────────────────────┐
 │ SHT31  SCD40     │ ──telemetría──► │ mosquitto │ ◄──► │ backend (FastAPI)           │
 │ suelo  4 relés   │ ◄──órdenes───── │ (broker)  │      │  · guarda mediciones        │
 └──────────────────┘                 └───────────┘      │  · decide relés cada 10 s   │
                                                         │  · API + página web :8090   │
 Celular ──Tailscale──► http://servidor:8090 ──────────► └──────────────┬──────────────┘
                                                                        │ red interna
                                                                  ┌─────▼─────┐
                                                                  │ postgres  │ (sin puerto expuesto)
                                                                  └───────────┘
```

📚 **Para entender cómo funciona cada parte, leé [`docs/COMO_FUNCIONA.md`](docs/COMO_FUNCIONA.md).**

## Estructura

| Carpeta | Qué hay |
|---|---|
| `docker-compose.yml`, `.env.example` | Los 3 servicios y su configuración |
| `mosquitto/` | Configuración del broker MQTT |
| `backend/app/` | API, conexión MQTT, base de datos y motor de automatización |
| `backend/tests/` | Pruebas del motor de automatización |
| `frontend/` | La página que se abre en el celular |
| `config/sala.yaml` | Relés y reglas iniciales |
| `firmware/` | Programa del ESP32 (PlatformIO) |
| `index.html` (raíz) | El dashboard anterior, que lee de ThingSpeak. No se tocó. |

## Hardware supuesto (ajustalo a lo tuyo)

| Qué | Modelo supuesto | Dónde se cambia |
|---|---|---|
| Placa | ESP32 DevKit (esp32dev) | `firmware/platformio.ini` |
| Temperatura y humedad | SHT31 (I2C, 0x44) | `firmware/include/config.h` |
| CO₂ + temp. 2 + hum. 2 | SCD40/SCD41 (I2C, 0x62) | ídem |
| Humedad de suelo | Sensor capacitivo v1.2 en GPIO34 | ídem (incluye calibración) |
| Relés | Módulo de 4 canales de lógica inversa: luz GPIO26, extractor 27, humidificador 25, riego 33 | `config.h` + `config/sala.yaml` |

Las variables (`temperatura`, `humedad`, `co2`, `temperatura2`, `humedad2`) siguen el mismo esquema que tu canal de ThingSpeak actual. Si no tenés algún sensor, comentá su `#define USAR_...` en `config.h`.

## Puesta en marcha en el servidor

```bash
git clone <este repo> ~/sala-cultivo && cd ~/sala-cultivo
cp .env.example .env
nano .env                      # cambiá TODAS las claves y la zona horaria
docker compose up -d --build
docker compose logs -f backend # deberías ver "Conectado al broker MQTT"
```

- **Desde el celular:** `http://<nombre-del-servidor-en-tailscale>:8090` (o `http://100.x.y.z:8090`).
- **Para que solo se vea por Tailscale:** en `.env` poné `WEB_BIND=<IP 100.x de Tailscale>`. Tailscale tiene que estar levantado antes que Docker al arrancar; si no lo está, el contenedor no puede escuchar en esa IP.
- **Firewall:** si usás `ufw`, abrí el 1883 solo para la red local, por ejemplo `sudo ufw allow from 192.168.1.0/24 to any port 1883`. Ojo: Docker publica sus puertos por fuera de `ufw`, así que conviene igual tener el broker con usuario y clave (ya viene así).

## Firmware del ESP32

```bash
cd firmware
cp include/config.example.h include/config.h
nano include/config.h          # Wi-Fi, IP LOCAL del servidor, clave MQTT del ESP32, pines
pio run -t upload && pio device monitor
```

En el monitor serie tenés que ver `MQTT conectado` y cada 30 s el JSON con las mediciones.

## Probar sin el ESP32

Podés simular la placa publicando a mano:

```bash
docker compose exec mosquitto mosquitto_pub -u esp32 -P <clave> \
  -t cultivo/sala1/telemetria -m '{"temperatura":29.5,"humedad":50}'
docker compose exec mosquitto mosquitto_sub -u esp32 -P <clave> -t 'cultivo/sala1/#' -v
```

## Pruebas

```bash
cd backend
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt pytest
.venv/bin/pytest
```

## Respaldo

```bash
docker compose exec db pg_dump -U cultivo cultivo | gzip > respaldo-$(date +%F).sql.gz
```
