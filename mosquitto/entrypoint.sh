#!/bin/sh
# Genera el archivo de contraseñas de Mosquitto con los usuarios definidos en .env
# y arranca el broker. Así la única fuente de verdad de las claves es el .env.
set -e

: "${MQTT_USUARIO_BACKEND:?falta MQTT_USUARIO_BACKEND en .env}"
: "${MQTT_USUARIO_ESP32:?falta MQTT_USUARIO_ESP32 en .env}"

# umask 077: los archivos nuevos solo los puede leer su dueño.
umask 077
PASSWD=/mosquitto/passwd
rm -f "$PASSWD"
touch "$PASSWD"
mosquitto_passwd -b "$PASSWD" "$MQTT_USUARIO_BACKEND" "$MQTT_CLAVE_BACKEND"
mosquitto_passwd -b "$PASSWD" "$MQTT_USUARIO_ESP32" "$MQTT_CLAVE_ESP32"
# Mosquitto exige que el archivo sea del usuario mosquitto y no lo pueda leer nadie más.
chown mosquitto:mosquitto "$PASSWD"
chmod 0600 "$PASSWD"

exec /usr/sbin/mosquitto -c /mosquitto/config/mosquitto.conf
