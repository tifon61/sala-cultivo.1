#!/bin/sh
# Genera el archivo de contraseñas de Mosquitto con los usuarios definidos en .env
# y arranca el broker. Así la única fuente de verdad de las claves es el .env.
#
#   MQTT_SALAS="sala1:clave1 sala2:clave2"   -> un usuario por módulo
#
# El usuario de cada módulo es el id de su sala: así la ACL (mosquitto/acl)
# puede limitar a cada uno a sus propios tópicos con el comodín %u.
set -e

: "${MQTT_CLAVE_BACKEND:?falta MQTT_CLAVE_BACKEND en .env}"
: "${MQTT_SALAS:?falta MQTT_SALAS en .env}"

# umask 077: los archivos nuevos solo los puede leer su dueño.
umask 077
PASSWD=/mosquitto/passwd
rm -f "$PASSWD"
touch "$PASSWD"
mosquitto_passwd -b "$PASSWD" backend "$MQTT_CLAVE_BACKEND"
for par in $MQTT_SALAS; do
  mosquitto_passwd -b "$PASSWD" "${par%%:*}" "${par#*:}"
done
cp /mosquitto/acl.original /mosquitto/acl
# Mosquitto exige que estos archivos sean del usuario mosquitto y no los pueda leer nadie más.
chown mosquitto:mosquitto "$PASSWD" /mosquitto/acl
chmod 0600 "$PASSWD" /mosquitto/acl

exec /usr/sbin/mosquitto -c /mosquitto/config/mosquitto.conf
