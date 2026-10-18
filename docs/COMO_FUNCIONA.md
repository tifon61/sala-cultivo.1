# Cómo funciona (para aprender)

Esta guía sigue el camino de un dato: del sensor al servidor y al celular, y de vuelta como orden a un relé. En cada parte te indica qué archivo mirar.

---

## 1. La idea general: quién decide

En la primera versión el servidor decidía todo y el ESP32 solo obedecía. Como ahora las salas están **lejos** del servidor, ese diseño es frágil: si se corta internet, nadie riega.

Por eso ahora **cada ESP32 decide solo**, con reglas que le manda el servidor:

| | ESP32 (en la sala) | Servidor (en casa) |
|---|---|---|
| Lee sensores | ✅ | |
| Evalúa reglas y mueve relés | ✅ cada 1 s, con o sin internet | |
| Guarda la configuración | ✅ en su flash (NVS) | ✅ en Postgres (la "oficial") |
| Historia, gráficos, bitácora | | ✅ |
| Dónde la cambiás | Red de emergencia (solo en el lugar) | Web, desde cualquier lugar |

La regla de convivencia es simple: **cuando hay conexión, manda el servidor**.

---

## 2. Cómo llega el ESP32 al servidor: MQTT + Tailscale Funnel

**MQTT** es un sistema de mensajes del tipo *publicar/suscribir*:

- Hay un intermediario, el broker (Mosquitto).
- Cada mensaje va a un *tópico*, como `cultivo/sala1/telemetria`.
- Quien publica no sabe quién escucha.

El ESP32 abre una conexión saliente hacia el broker y la mantiene abierta. Por esa misma conexión le llegan las órdenes, sin abrir puertos del lado de la sala.

| Tópico | Quién publica | Contenido |
|---|---|---|
| `cultivo/sala1/telemetria` | ESP32 | `{"ts":…, "temperatura":24.3, "dpv":1.1, "co2":800}` cada 30 s |
| `cultivo/sala1/reles` | ESP32 (retained) | Qué equipo está prendido y por qué |
| `cultivo/sala1/estado` | ESP32 / broker | `online` u `offline` (testamento) |
| `cultivo/sala1/config` | servidor (retained) | La configuración completa de la sala |

Tres conceptos que conviene entender:

- **Retained:** el broker guarda el último mensaje de ese tópico. La configuración se publica así, de modo que si el ESP32 estaba desconectado cuando la cambiaste, la recibe **apenas vuelve**.
- **Testamento (LWT):** el ESP32 deja dicho "si me caigo, publicá `offline`". Así la web sabe que se desconectó aunque la placa no haya podido avisar.
- **ACL:** cada placa usa como usuario el id de su sala, y `mosquitto/acl` usa `%u` para que `sala1` solo pueda tocar `cultivo/sala1/...`. Es importante porque el broker está en internet.

**Tailscale Funnel** (ver `docs/INSTALACION.md`) publica el broker en `servidor.tu-tailnet.ts.net:8443`. Además agrega **TLS**: el cifrado y la verificación de que el servidor es quien dice ser. El ESP32 lleva adentro los certificados raíz de Let's Encrypt (`firmware/src/certificados.h`) y rechaza cualquier servidor que no tenga un certificado válido para ese nombre. Sin TLS, cualquiera en el camino podría leer las claves o mandar órdenes falsas.

---

## 3. Las reglas (`firmware/src/reglas.cpp`)

Están escritas en C++ "puro", sin nada de Arduino, para poder probarlas en la PC (`firmware/test/test_reglas`). Cada segundo, para cada relé:

```
¿Está en manual y no venció?  ──sí──►  lo que pediste
         │ no
         ▼
   aplicar su regla automática
```

- **pulsos** (riego): prende `encendido_s` segundos cada `cada_min` minutos, contando desde la hora `desde` y solo hasta `hasta`. Ejemplo: 20 s cada 3 h desde las 08:00 riega a las 08:00, 11:00, 14:00 y 17:00.
- **umbral con histéresis** (DPV): el humidificador se prende si el DPV supera 1,2 y recién se apaga cuando baja de 1,1. Esa franja evita que el relé prenda y apague sin parar. El deshumidificador es el espejo (DPV bajo). Si sus umbrales no se pisan, nunca funcionan a la vez; hay un test que lo verifica.
- **horario** (luz): prendida entre dos horas; puede cruzar la medianoche.

**Equipos con timer externo.** Si la luz (u otro equipo) la maneja su propio timer, en la web se marca "Lo maneja un timer externo" y se carga el mismo horario del timer. Desde ahí:

- El servidor no le manda ese relé al módulo: un relé que no figura en la config queda apagado y libre para otra cosa.
- El estado (prendida/apagada) y la cuenta regresiva los calcula el servidor con ese horario, sin preguntarle nada al módulo.
- Ojo: la web muestra lo que *debería* estar haciendo el timer. Si se corta la luz y el timer mecánico se atrasa, la web no se entera. Para saberlo de verdad haría falta un sensor de luz (por ejemplo, un LDR en el módulo).

Decisiones de seguridad que vale la pena notar:

- Si un dato tiene más de 3 minutos, la regla de umbral **apaga**. Sin saber la humedad, no conviene dejar el humidificador prendido.
- **Sin hora** (por ejemplo, la placa se reinició sin internet):
  - la luz no puede seguir su horario y queda apagada;
  - los pulsos de riego siguen, contados desde el arranque: mejor regar a cualquier hora que no regar;
  - un manual con tiempo límite se ignora, porque no se podría saber cuándo vence (y una bomba manual sin fin inunda la sala).

  La hora se recupera sola por internet (NTP), o desde el celular en la red de emergencia. Un módulo RTC DS3231 resolvería esto del todo.

---

## 4. Dos tareas al mismo tiempo (`firmware/src/main.cpp`)

El ESP32 corre **FreeRTOS**, un sistema que permite tener varias tareas en paralelo:

- **`tareaControl`:** sensores, reglas y relés, cada 1 s.
- **`loop()`:** todo lo de red (Wi-Fi, MQTT, red de emergencia, página local).

¿Por qué separarlas? Conectarse a un servidor con TLS puede **bloquear 10 segundos o más**. Si eso pasara en la misma tarea que el riego, un pulso de 20 s podría durar 35.

Como las dos tareas tocan los mismos datos (lecturas, estado de los relés), se protegen con un **candado** (`Bloqueo`): mientras una lee o escribe, la otra espera. Sin el candado, una tarea podría leer un dato a medio escribir.

---

## 5. La red de emergencia

Si pasan 2 minutos sin servidor, el ESP32 pasa a modo **AP+STA**: sigue buscando el Wi-Fi de siempre (STA) y a la vez crea su propia red (AP).

- **DNSServer:** responde cualquier dominio con la IP de la placa. Por eso el celular muestra la página sola, como el Wi-Fi de un hotel (*portal cautivo*).
- **La página** (`pagina_local.h`) va dentro del firmware como texto. Solo responde a quien está conectado a esa red.
- **Mientras alguien está conectado, la placa no intenta reconectarse.** Buscar el Wi-Fi obliga a la placa a cambiar de canal, y eso desconectaría al celular.
- **Mediciones guardadas:** las que no se pudieron enviar quedan en un *buffer circular* de hasta 6 horas y se mandan con su hora real cuando vuelve la conexión. Así el gráfico no queda con huecos.

---

## 6. El servidor (`backend/app/`)

- **`servicio.py`:** escucha a los módulos y guarda lo que mandan. Si una medición llega atrasada (del buffer), se guarda con su hora real y no reemplaza a la última.
- **`modelos.py`:** valida la configuración **antes** de mandarla (una regla mal escrita nunca llega a la placa). También calcula el "próximo cambio" que ves en el esquema.
- **`main.py`:** la API. Cada cambio sube la `version` de la config de esa sala. El ESP32 informa qué versión aplicó, y si no coinciden, la web te avisa con "configuración pendiente".
- **`acceso.py`:** la clave de la web (`WEB_CLAVE`). Al ingresar, el servidor deja una cookie **firmada con HMAC** que vence a los 30 días. Nadie puede fabricarla ni alargarla sin saber la clave, y cambiar la clave cierra todas las sesiones. Después de 5 intentos fallidos desde una IP, hace esperar un minuto.
- **Bitácora:** tabla `bitacora`. La etapa actual es la última entrada de tipo *etapa* según su fecha. Por eso podés cargar "pasé a floración el 26/09" días después y el contador queda bien.

👉 Para ver los mensajes en vivo: `docker compose exec mosquitto mosquitto_sub -u backend -P <clave> -t 'cultivo/#' -v`
👉 Para ver la API interactiva: `http://servidor:8090/docs`

---

## 7. ¿Y Node-RED?

Node-RED sirve para armar flujos visuales rápido, pero para esto tiene contras:

- la lógica queda en un JSON difícil de versionar y de probar;
- se ejecuta en el servidor, así que si se corta internet, la sala queda sin control.

Acá cada pieza es código que se lee, se prueba y queda en git, y la lógica crítica vive en la placa.

La alternativa "lista para usar" sería **ESPHome + Home Assistant**. Es excelente, pero con las salas lejos del servidor igual habría que resolver la conexión (MQTT + Funnel), y aprenderías menos de cómo funciona por dentro.

---

## 8. Ideas para seguir aprendiendo

1. **Mejor sensor:** cambiar el DHT11 por un SHT31 o SHT40. Mirá `medir()` en `main.cpp`.
2. **RTC DS3231:** que el módulo no pierda la hora al reiniciarse sin internet.
3. **Alertas:** un mensaje (Telegram o ntfy.sh) si una sala pasa 10 minutos `offline` o la temperatura supera 32 °C. Encaja en `servicio.py`.
4. **Regla combinada:** deshumidificador solo con la luz apagada. Primero el test en `test_reglas`, después el código.
5. **Actualizar el firmware por internet (OTA):** para no tener que viajar con la notebook cada vez.
