"""El "cerebro" del sistema: escucha al ESP32 por MQTT, guarda las mediciones
y cada pocos segundos decide y envía el estado de cada relé.

Tópicos MQTT (con DISPOSITIVO=sala1):

  ESP32 -> servidor
    cultivo/sala1/telemetria          {"temperatura": 24.3, "humedad": 61, ...}
    cultivo/sala1/estado              "online" / "offline" (retained + testamento)
    cultivo/sala1/rele/<id>/estado    "ON" / "OFF" (retained): lo que el ESP32 aplicó

  servidor -> ESP32
    cultivo/sala1/rele/<id>/set       "ON" / "OFF", se reenvía cada CICLO_SEGUNDOS.
                                      Si el ESP32 deja de recibirlo, entra en modo seguro.
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
from zoneinfo import ZoneInfo

import aiomqtt

from . import db
from .automatizacion import Contexto, Decision, Lectura, decidir, leer_regla, manual_vigente

log = logging.getLogger(__name__)

CICLO_SEGUNDOS = 10
MAX_EDAD_DATO = timedelta(minutes=3)
NOMBRE_VARIABLE = re.compile(r"^[a-z][a-z0-9_]{0,39}$")


def calcular_dpv(temp_c: float, hum_rel: float) -> float:
    """Déficit de presión de vapor (kPa), fórmula de Tetens (la misma del dashboard viejo)."""
    presion_saturacion = 0.61078 * math.exp(17.27 * temp_c / (temp_c + 237.3))
    return round(presion_saturacion * (1 - hum_rel / 100), 3)


@dataclass
class EstadoRele:
    deseado: Optional[bool] = None      # lo que decidió el servidor
    reportado: Optional[bool] = None    # lo que el ESP32 dice que aplicó
    motivo: str = "sin evaluar"


@dataclass
class Servicio:
    pool: object
    dispositivo: str
    zona: ZoneInfo
    mqtt_host: str
    mqtt_puerto: int
    mqtt_usuario: Optional[str]
    mqtt_clave: Optional[str]

    lecturas: dict[str, Lectura] = field(default_factory=dict)
    reles: dict[str, EstadoRele] = field(default_factory=dict)
    online: bool = False
    mqtt_conectado: bool = False
    _cliente: Optional[aiomqtt.Client] = None
    _despertar: asyncio.Event = field(default_factory=asyncio.Event)

    @property
    def base(self) -> str:
        return f"cultivo/{self.dispositivo}"

    async def cargar_estado_inicial(self) -> None:
        for fila in await db.ultimas_lecturas(self.pool):
            self.lecturas[fila["variable"]] = Lectura(fila["valor"], fila["ts"])
        # Partimos del último estado registrado, así un reinicio no anota cambios falsos.
        for fila in await db.ultimo_estado_reles(self.pool):
            self.reles[fila["rele"]] = EstadoRele(deseado=fila["estado"], motivo=fila["motivo"])

    def reevaluar_ya(self) -> None:
        """Lo llama la API después de un cambio manual, para no esperar al próximo ciclo."""
        self._despertar.set()

    # ------------------------------------------------------------------ MQTT

    async def bucle_mqtt(self) -> None:
        while True:
            try:
                async with aiomqtt.Client(
                    self.mqtt_host, self.mqtt_puerto,
                    username=self.mqtt_usuario, password=self.mqtt_clave,
                    identifier=f"backend-{self.dispositivo}",
                ) as cliente:
                    self._cliente = cliente
                    self.mqtt_conectado = True
                    log.info("Conectado al broker MQTT %s:%s", self.mqtt_host, self.mqtt_puerto)
                    await cliente.subscribe(f"{self.base}/telemetria")
                    await cliente.subscribe(f"{self.base}/estado")
                    await cliente.subscribe(f"{self.base}/rele/+/estado")
                    self.reevaluar_ya()
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
        if topico == f"{self.base}/telemetria":
            await self._guardar_telemetria(texto)
        elif topico == f"{self.base}/estado":
            self.online = texto.strip() == "online"
        elif topico.startswith(f"{self.base}/rele/") and topico.endswith("/estado"):
            rid = topico.split("/")[-2]
            self.reles.setdefault(rid, EstadoRele()).reportado = texto.strip().upper() == "ON"

    async def _guardar_telemetria(self, texto: str) -> None:
        try:
            datos = json.loads(texto)
        except json.JSONDecodeError:
            log.warning("Telemetría que no es JSON: %r", texto[:200])
            return
        if not isinstance(datos, dict):
            return

        # Solo aceptamos números finitos con nombres de variable razonables.
        valores = {
            k: float(v) for k, v in datos.items()
            if NOMBRE_VARIABLE.match(k) and isinstance(v, (int, float))
            and not isinstance(v, bool) and math.isfinite(v)
        }
        if "temperatura" in valores and "humedad" in valores:
            valores["dpv"] = calcular_dpv(valores["temperatura"], valores["humedad"])
        if not valores:
            return

        ahora = datetime.now(timezone.utc)
        await db.guardar_mediciones(self.pool, ahora, self.dispositivo, valores)
        for var, val in valores.items():
            self.lecturas[var] = Lectura(val, ahora)
        self.online = True

    # -------------------------------------------------------- automatización

    async def bucle_automatizacion(self) -> None:
        while True:
            try:
                await self.evaluar_y_enviar()
            except Exception:
                log.exception("Error en el ciclo de automatización")
            # Espera CICLO_SEGUNDOS o hasta que alguien llame a reevaluar_ya().
            try:
                await asyncio.wait_for(self._despertar.wait(), timeout=CICLO_SEGUNDOS)
            except asyncio.TimeoutError:
                pass
            self._despertar.clear()

    async def evaluar_y_enviar(self) -> None:
        ahora = datetime.now(self.zona)
        ctx = Contexto(ahora=ahora, lecturas=self.lecturas, max_edad_dato=MAX_EDAD_DATO)

        for fila in await db.listar_reles(self.pool):
            rid = fila["id"]
            estado = self.reles.setdefault(rid, EstadoRele())

            # Un manual con tiempo que ya venció vuelve a automático.
            if fila["modo"] == "manual" and not manual_vigente("manual", fila["manual_hasta"], ahora):
                await db.poner_auto(self.pool, rid)

            try:
                regla = leer_regla(fila["regla"])
                decision = decidir(fila["modo"], fila["manual_estado"], fila["manual_hasta"],
                                   regla, ctx, bool(estado.deseado))
            except Exception as e:  # regla corrupta: apagamos por seguridad
                decision = Decision(False, f"regla inválida: {e}")

            if decision.encendido != estado.deseado:
                await db.registrar_evento(self.pool, rid, decision.encendido, decision.motivo)
                log.info("Relé %s -> %s (%s)", rid, "ON" if decision.encendido else "OFF", decision.motivo)
            estado.deseado = decision.encendido
            estado.motivo = decision.motivo

            if self._cliente is not None:
                await self._cliente.publish(
                    f"{self.base}/rele/{rid}/set", "ON" if decision.encendido else "OFF", qos=1
                )
