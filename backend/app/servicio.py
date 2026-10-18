"""Comunicación con los módulos ESP32 por MQTT.

El servidor ya no decide los relés: eso lo hace cada ESP32 (así siguen
funcionando sin internet). El servidor:
  * guarda las mediciones y los cambios de relés que informan los módulos,
  * les manda la configuración (reglas, modo manual) cuando la cambiás.

Tópicos, para cada sala <id> (sala1, sala2...):

  ESP32 -> servidor
    cultivo/<id>/telemetria   {"ts": 1792250000, "temperatura": 24.3, "dpv": 1.1, ...}
    cultivo/<id>/estado       "online" / "offline" (retained + testamento)
    cultivo/<id>/reles        {"version": 4, "reles": {"luz": {"on": true, "motivo": "..."}}, ...} (retained)

  servidor -> ESP32
    cultivo/<id>/config       la configuración completa (retained: le llega apenas se conecta)
"""
from __future__ import annotations

import asyncio
import json
import logging
import math
import re
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Optional

import aiomqtt

from . import db

log = logging.getLogger(__name__)

NOMBRE_VARIABLE = re.compile(r"^[a-z][a-z0-9_]{0,39}$")
MAX_ATRASO = timedelta(days=7)  # mediciones guardadas en el ESP32 más viejas que esto se descartan


def calcular_dpv(temp_c: float, hum_rel: float) -> float:
    """Déficit de presión de vapor (kPa), fórmula de Tetens (la misma que usa el ESP32)."""
    presion_saturacion = 0.61078 * math.exp(17.27 * temp_c / (temp_c + 237.3))
    return round(presion_saturacion * (1 - hum_rel / 100), 3)


@dataclass
class Lectura:
    valor: float
    ts: datetime


@dataclass
class EstadoSala:
    """Lo último que sabemos de un módulo (en memoria; se arma con lo que va llegando)."""
    online: bool = False
    lecturas: dict[str, Lectura] = field(default_factory=dict)
    reles: dict[str, dict] = field(default_factory=dict)   # id -> {"on", "motivo"}
    reporte: dict = field(default_factory=dict)            # último mensaje de /reles completo
    ultimo_reporte: Optional[datetime] = None


@dataclass
class Servicio:
    pool: object
    mqtt_host: str
    mqtt_puerto: int
    mqtt_usuario: Optional[str]
    mqtt_clave: Optional[str]

    salas: dict[str, EstadoSala] = field(default_factory=dict)
    mqtt_conectado: bool = False
    _cliente: Optional[aiomqtt.Client] = None

    async def cargar_estado_inicial(self) -> None:
        for fila in await db.listar_salas(self.pool):
            self.salas[fila["id"]] = EstadoSala()
        for fila in await db.ultimas_lecturas(self.pool):
            if fila["dispositivo"] in self.salas:
                self.salas[fila["dispositivo"]].lecturas[fila["variable"]] = Lectura(fila["valor"], fila["ts"])
        # Partimos del último estado registrado, así un reinicio no anota cambios falsos.
        for fila in await db.ultimo_estado_reles(self.pool):
            if fila["dispositivo"] in self.salas:
                self.salas[fila["dispositivo"]].reles[fila["rele"]] = {"on": fila["estado"], "motivo": ""}

    # ------------------------------------------------------------------ envío

    async def publicar_config(self, sala: str) -> None:
        """Manda la config de una sala como mensaje retained (si el ESP32 está
        desconectado, el broker se la entrega apenas vuelva)."""
        fila = await db.obtener_sala(self.pool, sala)
        if fila is None or self._cliente is None:
            return
        config = fila["config"]
        # Los equipos con timer externo no se le mandan al módulo: un relé que no
        # figura en la config queda apagado (y libre para otra cosa).
        reles = {rid: r for rid, r in config["reles"].items() if not r.get("externo")}
        mensaje = dict(config, reles=reles, version=fila["version"])
        await self._cliente.publish(f"cultivo/{sala}/config", json.dumps(mensaje), qos=1, retain=True)
        log.info("Config de %s publicada (versión %d)", sala, fila["version"])

    # ------------------------------------------------------------------ MQTT

    async def bucle_mqtt(self) -> None:
        while True:
            try:
                async with aiomqtt.Client(
                    self.mqtt_host, self.mqtt_puerto,
                    username=self.mqtt_usuario, password=self.mqtt_clave,
                    identifier="backend-cultivo",
                ) as cliente:
                    self._cliente = cliente
                    self.mqtt_conectado = True
                    log.info("Conectado al broker MQTT %s:%s", self.mqtt_host, self.mqtt_puerto)
                    for topico in ("telemetria", "estado", "reles"):
                        await cliente.subscribe(f"cultivo/+/{topico}", qos=1)
                    for sala in self.salas:
                        await self.publicar_config(sala)
                    async for msg in cliente.messages:
                        try:
                            await self._procesar(str(msg.topic), msg.payload.decode(errors="replace"))
                        except Exception:
                            log.exception("Error procesando mensaje en %s", msg.topic)
            except aiomqtt.MqttError as e:
                log.warning("MQTT desconectado (%s); reintento en 5 s", e)
            finally:
                self._cliente = None
                self.mqtt_conectado = False
            await asyncio.sleep(5)

    async def _procesar(self, topico: str, texto: str) -> None:
        partes = topico.split("/")
        if len(partes) != 3:
            return
        _, sala, tipo = partes
        estado = self.salas.get(sala)
        if estado is None:
            log.warning("Mensaje de una sala desconocida: %s", topico)
            return
        if tipo == "estado":
            estado.online = texto.strip() == "online"
        elif tipo == "telemetria":
            await self._guardar_telemetria(sala, estado, texto)
        elif tipo == "reles":
            await self._guardar_reles(sala, estado, texto)

    async def _guardar_telemetria(self, sala: str, estado: EstadoSala, texto: str) -> None:
        try:
            datos = json.loads(texto)
        except json.JSONDecodeError:
            log.warning("Telemetría de %s que no es JSON: %r", sala, texto[:200])
            return
        if not isinstance(datos, dict):
            return

        # Si el ESP32 mandó "ts" (mediciones que guardó sin conexión) usamos esa hora.
        ahora = datetime.now(timezone.utc)
        ts = ahora
        if isinstance(datos.get("ts"), (int, float)):
            del_equipo = datetime.fromtimestamp(datos["ts"], timezone.utc)
            if ahora - MAX_ATRASO < del_equipo <= ahora + timedelta(minutes=2):
                ts = del_equipo

        valores = {
            k: float(v) for k, v in datos.items()
            if k != "ts" and NOMBRE_VARIABLE.match(k) and isinstance(v, (int, float))
            and not isinstance(v, bool) and math.isfinite(v)
        }
        if "dpv" not in valores and "temperatura" in valores and "humedad" in valores:
            valores["dpv"] = calcular_dpv(valores["temperatura"], valores["humedad"])
        if not valores:
            return

        await db.guardar_mediciones(self.pool, ts, sala, valores)
        for var, val in valores.items():
            previa = estado.lecturas.get(var)
            if previa is None or ts >= previa.ts:  # una medición atrasada no pisa la última
                estado.lecturas[var] = Lectura(val, ts)
        estado.online = True

    async def _guardar_reles(self, sala: str, estado: EstadoSala, texto: str) -> None:
        try:
            datos = json.loads(texto)
        except json.JSONDecodeError:
            return
        if not isinstance(datos, dict) or not isinstance(datos.get("reles"), dict):
            return
        for rid, r in datos["reles"].items():
            if not isinstance(r, dict):
                continue
            on, motivo = bool(r.get("on")), str(r.get("motivo", ""))[:120]
            previo = estado.reles.get(rid)
            if previo is None or previo["on"] != on:
                await db.registrar_evento(self.pool, sala, rid, on, motivo)
            estado.reles[rid] = {"on": on, "motivo": motivo}
        estado.reporte = datos
        estado.ultimo_reporte = datetime.now(timezone.utc)
