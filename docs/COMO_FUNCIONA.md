# Cómo funciona (para aprender)

Esta guía recorre el sistema en el orden en que viaja un dato: del sensor a la base de datos, de ahí al celular, y de vuelta del celular al relé. En cada parte te dice qué archivo mirar.

---

## 1. La idea general: un cerebro y unas manos

- El **ESP32** hace de *manos y ojos*: mide, publica las mediciones y obedece órdenes.
- El **backend** (en el servidor) hace de *cerebro*: guarda los datos y decide qué hacer.

¿Por qué no poner la lógica en el ESP32? Porque así cambiás un horario o un umbral desde el celular y listo. No hace falta volver a programar la placa, y toda la historia queda en un solo lugar.

El riesgo de este diseño es quedarse sin cerebro: el servidor se apaga o se corta el Wi-Fi. Por eso el ESP32 tiene **una sola** decisión propia, el *modo seguro* (ver punto 5).

---

## 2. MQTT: cómo se hablan el ESP32 y el servidor

MQTT es un protocolo de mensajes del tipo **publicar/suscribir**:

- Hay un intermediario, el **broker** (Mosquitto, un contenedor).
- Cada mensaje va a un **tópico**, que es un texto con forma de ruta, como `cultivo/sala1/telemetria`.
- Quien publica no sabe quién escucha. Quien se suscribe recibe todo lo que llegue a ese tópico.

¿Por qué no HTTP? Porque el ESP32 necesita *recibir* órdenes. Con MQTT, la placa abre una conexión al broker y la mantiene abierta, y el servidor le manda los mensajes por ahí. No hace falta abrir puertos en el ESP32 ni que este pregunte cada segundo "¿hay algo nuevo?".

Los tópicos de este proyecto:

| Tópico | Quién publica | Contenido |
|---|---|---|
| `cultivo/sala1/telemetria` | ESP32 | `{"temperatura":24.3,"humedad":61,"co2":800,...}` cada 30 s |
| `cultivo/sala1/estado` | ESP32 / broker | `online` u `offline` |
| `cultivo/sala1/rele/luz/set` | backend | `ON` / `OFF`: la orden |
| `cultivo/sala1/rele/luz/estado` | ESP32 | `ON` / `OFF`: la confirmación de lo que aplicó |

Hay tres conceptos de MQTT que vale la pena conocer:

- **Retained:** el broker guarda el último mensaje del tópico y se lo entrega al que se suscribe después. Se usa para `estado`: si el backend se reinicia, sabe enseguida cómo está cada relé.
- **Testamento (Last Will, LWT):** al conectarse, el ESP32 le deja al broker un mensaje para publicar si la conexión se corta de golpe: `offline`. Así la web se entera aunque la placa no haya podido avisar. Está en `conectarMqtt()` del firmware.
- **Comodín `+`:** `cultivo/sala1/rele/+/set` significa "cualquier relé". El ESP32 se suscribe así una sola vez para todos.

👉 Para *ver* el tráfico en vivo, abrí una terminal con:
`docker compose exec mosquitto mosquitto_sub -u backend -P <clave> -t 'cultivo/#' -v`

---

## 3. Guardar las mediciones (`backend/app/servicio.py`, `backend/app/db.py`)

Cuando llega un mensaje a `telemetria`, el backend sigue estos pasos:

1. Parsea el JSON y descarta lo que no sea un número válido. Nunca hay que confiar en lo que llega por la red.
2. Si hay `temperatura` y `humedad`, calcula el **DPV** (déficit de presión de vapor) con la misma fórmula que tu dashboard de ThingSpeak.
3. Inserta una fila por variable en la tabla `mediciones`.

La tabla tiene formato **"largo"**: `(ts, dispositivo, variable, valor)`. La alternativa sería una columna por sensor. La ventaja del formato largo es que, si mañana agregás un sensor `suelo2`, no hay que tocar la base: el ESP32 manda una clave nueva en el JSON y aparece sola, con tarjeta y gráfico incluidos.

Para los gráficos de muchos días no se mandan miles de puntos: `date_bin` agrupa las mediciones en intervalos y promedia (por ejemplo, 30 días quedan en unos 400 puntos por variable). Mirá `historico()` en `db.py`.

¿Por qué Postgres en un contenedor propio y sin `ports:`? Así queda accesible solo dentro de la red de este Compose y no choca con el 5432 del sistema meteorológico. Si querés curiosear la base:
`docker compose exec db psql -U cultivo -d cultivo`
y probá por ejemplo `SELECT * FROM mediciones ORDER BY ts DESC LIMIT 10;`.

---

## 4. Decidir los relés (`backend/app/automatizacion.py`)

Cada 10 segundos (o al instante, si tocaste un botón en la web), el backend recorre los relés y decide para cada uno:

```
¿Está en manual y no venció?  ──sí──►  lo que pediste
         │ no
         ▼
   aplicar su regla automática
```

Este archivo está escrito con **funciones puras**: no leen la base ni MQTT, solo reciben datos y devuelven una `Decision(encendido, motivo)`. Por eso es fácil de probar (mirá `backend/tests/test_automatizacion.py`), y el "motivo" es el texto que ves en la web debajo de cada relé.

Las tres reglas:

- **horario:** prendido entre dos horas. El caso que cruza la medianoche (por ejemplo, 18:00 → 06:00) se resuelve en `en_ventana()`.
- **umbral con histéresis:** imaginá el extractor con umbral de 28 °C. Sin histéresis, a 28,0 se prende, baja a 27,9 y se apaga, sube y se prende otra vez… El relé "tiritea" y se gasta. Con histéresis de 1,5 se prende arriba de 28 y recién se apaga debajo de 26,5. En el medio, mantiene lo que estaba haciendo.
- **ciclo:** por ejemplo, riego de 2 minutos cada 8 horas desde las 09:00, dos veces por día.

Un detalle de seguridad: si el dato de un sensor tiene más de 3 minutos, la regla de umbral **apaga** el relé. Si no sabés la humedad, es mejor no dejar el humidificador prendido "por las dudas".

Cada cambio queda en `eventos_reles`, que es la lista de "Últimos cambios" de la web.

---

## 5. El ESP32 obedece y se cuida solo (`firmware/src/main.cpp`)

- El backend reenvía la orden de cada relé **cada 10 s**, aunque no haya cambiado. Ese reenvío funciona como un "latido".
- Si el ESP32 pasa 5 minutos (`FAILSAFE_MS`) sin recibir órdenes, pone cada relé en su `estadoSeguro`, que por defecto es apagado.
- Al arrancar, los relés quedan en estado seguro hasta que llegue la primera orden. Antes de configurar cada pin como salida se le fija el nivel, para que los relés no "pestañeen" al encender la placa.
- **Lógica inversa (activo bajo):** la mayoría de los módulos de relés se activan con 0 V. Por eso existe `RELE_ACTIVO_BAJO`.
- **Pines:** el sensor de suelo usa el GPIO34 porque es del ADC1. Los pines del ADC2 no se pueden leer mientras el Wi-Fi está activo. Los relés usan los GPIO 25, 26, 27 y 33, que no interfieren con el arranque de la placa.
- **Sin `delay()` largos en `loop()`:** la reconexión se intenta cada 5 s comparando `millis()`. Así la placa sigue atendiendo los mensajes mientras tanto.

---

## 6. La página del celular (`frontend/`)

Es HTML, CSS y JavaScript sin frameworks, para que puedas leerlo de punta a punta. Funciona así:

- Cada 5 s pide `GET /api/estado` y actualiza las tarjetas y los relés.
- Cada 60 s pide `GET /api/historico?horas=24` y redibuja los gráficos, uno por unidad (°C, %, kPa, ppm).
- Los botones llaman a `POST /api/reles/<id>/manual` o `/auto`, y "Guardar regla" llama a `PUT /api/reles/<id>/regla`.

Chart.js está copiado en `frontend/vendor/` para que la página no dependa de un CDN externo.

👉 FastAPI genera documentación interactiva de la API en `http://servidor:8090/docs`. Desde ahí podés probar cada endpoint sin la web.

---

## 7. Seguridad, en resumen

- **Web:** no tiene login. La protección es que solo se accede por tu red o por Tailscale, que ya autentica cada dispositivo. **No** expongas el 8090 a internet con un port-forward del router.
- **MQTT:** tiene usuario y clave. Las credenciales salen del `.env`, que no se sube a git.
- **Postgres:** no es accesible desde fuera de Docker.

---

## 8. Ideas para seguir aprendiendo

1. **Regla combinada:** que el extractor funcione por temperatura *solo con la luz prendida*. Pista: agregar un campo opcional `solo_entre` a `ReglaUmbral` y usar `en_ventana()`. Escribí primero el test.
2. **Umbral por DPV:** ya podés hacerlo, porque `dpv` es una variable más. Probá una regla `umbral` con `variable: dpv`.
3. **Alertas:** mandar un mensaje (Telegram, ntfy.sh) si la temperatura pasa de 32 °C o si el ESP32 está `offline` más de 10 minutos.
4. **ACL en Mosquitto:** que el usuario `esp32` solo pueda publicar en `telemetria` y `estado`, y no en `set`.
5. **Retención de datos:** borrar o promediar las mediciones de más de un año (con un cron y `DELETE ... WHERE ts < now() - interval '1 year'`).
6. **OTA:** actualizar el firmware del ESP32 por Wi-Fi sin cable (ArduinoOTA).
