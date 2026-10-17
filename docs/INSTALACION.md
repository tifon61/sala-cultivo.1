# Instalación paso a paso

Todo lo del servidor se puede hacer **a distancia** desde la notebook, por SSH sobre Tailscale. Solo hace falta estar físicamente en la sala para cargarle el programa a los ESP32 por USB.

---

## 0. Antes de salir de casa (una sola vez)

En el servidor:

```bash
sudo tailscale set --ssh        # habilita entrar por SSH a través de Tailscale
```

En la notebook, con Tailscale abierto y con la misma cuenta, probá:

```bash
ssh <tu-usuario>@<nombre-del-servidor>     # ej: ssh mauricio@servidor-casa
```

Si entra, ya podés hacer todo lo que sigue desde cualquier lugar.

En la notebook instalá también **VS Code** y la extensión **PlatformIO IDE**. La primera vez descarga unos 300 MB, así que conviene hacerlo con buena conexión.

---

## 1. Servidor: bajar el proyecto y configurar claves

Por SSH en el servidor:

```bash
cd ~
git clone https://github.com/tifon61/sala-cultivo.1.git sala-cultivo
cd sala-cultivo
git checkout claude/upbeat-bell-mh31ne     # la rama con este sistema (o main, cuando la mezcles)
cp .env.example .env
nano .env
```

En el `.env` cambiá **todas** las claves. Para inventarlas: `openssl rand -base64 18`. Lo más importante:

```
MQTT_SALAS="sala1:CLAVE-LARGA-1 sala2:CLAVE-LARGA-2"
```

Anotá esas dos claves: van en el firmware de cada placa.

Y la clave para entrar a la web (la pide una vez por dispositivo y la recuerda 30 días):

```
WEB_CLAVE=<una clave que recuerdes>
```

Después, levantá todo:

```bash
docker compose up -d --build
docker compose logs -f backend       # Ctrl+C para salir
```

Tenés que ver `Conectado al broker MQTT` y `Config de sala1 publicada`.

La web ya funciona: abrí `http://<nombre-del-servidor>:8090` en el celular o la notebook, con Tailscale activo.

---

## 2. Servidor: abrir el broker a internet con Tailscale Funnel

Los ESP32 no tienen Tailscale, así que necesitan llegar al servidor por internet. **Tailscale Funnel** se encarga de eso:

- publica **solo** el broker MQTT, en `https://<servidor>.<tu-tailnet>.ts.net:8443`;
- pone el cifrado TLS con un certificado válido (Let's Encrypt);
- no hay que abrir puertos en el router y funciona aunque tu proveedor use CGNAT.

**a. Activar Funnel en tu cuenta** (una vez, desde el navegador): entrá a https://login.tailscale.com/admin. En **DNS**, activá *MagicDNS* y *HTTPS Certificates*. Después, en **Access controls**, agregá el permiso `funnel` para el servidor; si no está, el comando del paso b te muestra un link para habilitarlo con un clic.

**b. En el servidor**, por SSH:

```bash
sudo tailscale funnel --bg --tls-terminated-tcp=8443 tcp://localhost:1883
tailscale funnel status         # tiene que mostrar el puerto 8443 -> tcp://localhost:1883
tailscale status --self         # el nombre completo: servidor.tu-tailnet.ts.net
```

`--bg` hace que quede activo aunque cierres la sesión y que vuelva después de reiniciar. Para sacarlo: `sudo tailscale funnel --tls-terminated-tcp=8443 off`.

> 🔒 Solo el broker queda expuesto a internet. Tiene usuario y clave por sala, y cada sala solo puede tocar sus propios tópicos (`mosquitto/acl`). La web **no** se publica: solo se ve por Tailscale.

**c. Probar desde la notebook**, aunque no esté en la red de casa:

```bash
# Si tenés mosquitto-clients instalado:
mosquitto_sub -h servidor.tu-tailnet.ts.net -p 8443 --capath /etc/ssl/certs \
  -u sala1 -P CLAVE-LARGA-1 -t 'cultivo/sala1/config' -C 1
```

Si imprime un JSON con los relés, el camino funciona.

---

## 2b. (Opcional) La web desde cualquier lugar, sin Tailscale

Por defecto la web solo se ve desde dispositivos con Tailscale. Para abrirla desde **cualquier** celular o computadora, se publica también con Funnel, en el puerto **10000**. El 443 lo usa el sistema meteorológico y el 8443 el broker; Funnel solo permite esos tres.

```bash
sudo tailscale funnel --bg --https=10000 http://localhost:8090
tailscale funnel status
```

La dirección queda así: `https://<servidor>.<tu-tailnet>.ts.net:10000`. Para sacarla: `sudo tailscale funnel --https=10000 off`.

⚠️ **Antes de hacerlo, poné una `WEB_CLAVE` larga** (16 caracteres o más, letras y números al azar). Los certificados de `*.ts.net` son públicos, así que hay robots que encuentran estas direcciones y prueban claves. Para frenarlos:
- después de 5 intentos fallidos desde una IP, esa IP espera un minuto;
- si fallan 20 intentos en total (desde cualquier IP), el ingreso se frena para todos durante un minuto, incluido vos.

Con una clave larga, adivinarla es imposible en la práctica.

## 3. Firmware: una placa por sala

En la notebook, con el proyecto clonado:

```bash
cd firmware
cp include/config.example.h include/config.h
```

Editá `include/config.h` con los datos de la **sala 1**:

| Campo | Valor |
|---|---|
| `DISPOSITIVO` | `"sala1"` |
| `WIFI_SSID` y `WIFI_CLAVE` | El Wi-Fi del lugar de las salas |
| `MQTT_HOST` | `"servidor.tu-tailnet.ts.net"` (el nombre del paso 2b) |
| `MQTT_PUERTO` | `8443` |
| `MQTT_TLS` | `true` |
| `MQTT_CLAVE` | La clave de `sala1` del `.env` |
| `AP_NOMBRE` | Nombre de la red de emergencia (mejor uno neutro, que no diga "cultivo") |
| `AP_CLAVE` | Clave de la red de emergencia (mínimo 8 caracteres) |
| `ZONA_HORARIA` | La tuya (hay ejemplos en el archivo) |

Conectá la placa por USB y ejecutá:

```bash
pio run -t upload && pio device monitor
```

En el monitor tenés que ver `MQTT conectado` y `Config aplicada (versión N, servidor)`.

Para la **sala 2**, repetí con `DISPOSITIVO "sala2"` y su clave.

> Si el puerto USB no aparece, falta el driver del chip USB de la placa (CP210x o CH340, según el modelo).

---

## 4. Si algo no anda: la red de emergencia

Si un módulo pasa 2 minutos sin hablar con el servidor, crea un Wi-Fi propio con el nombre `AP_NOMBRE` (si no lo definiste, **`Cultivo-sala1`** o `Cultivo-sala2`) y la clave `AP_CLAVE`.

1. Conectate con el celular a ese Wi-Fi y abrí **http://192.168.4.1**.
2. Desde ahí podés:
   - ver las lecturas y el estado de cada equipo;
   - prender o apagar equipos;
   - cambiar las reglas;
   - corregir el Wi-Fi o el servidor;
   - poner la hora del celular, si el módulo no la tiene.
3. Cuando vuelve la conexión, **manda la configuración del servidor**: lo que cambiaste en el lugar se reemplaza. Si querés conservarlo, cargalo también en la web.

Mientras tanto, el módulo sigue regulando la sala solo y guarda hasta 6 horas de mediciones, que manda al servidor cuando vuelve la conexión.

---

## 5. Actualizar en el futuro

Por SSH en el servidor:

```bash
cd ~/sala-cultivo && git pull && docker compose up -d --build
```

## Respaldo de la base

```bash
docker compose exec db pg_dump -U cultivo cultivo | gzip > respaldo-$(date +%F).sql.gz
```
