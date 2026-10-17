"""API web (FastAPI). También sirve la página del celular desde /frontend.

Arranque: conecta a Postgres, crea tablas, carga las salas de config/salas.yaml
que falten y lanza en segundo plano la conexión MQTT con los módulos.
"""
from __future__ import annotations

import asyncio
import logging
import os
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Literal, Optional
from zoneinfo import ZoneInfo

import yaml
from fastapi import FastAPI, HTTPException, Query
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field, ValidationError, model_validator

from . import db
from .modelos import ETAPAS, TIPOS_BITACORA, ConfigSala, proximo_cambio, regla_adapter
from .servicio import Servicio

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")

RAIZ = Path(__file__).resolve().parent.parent
CONFIG = Path(os.environ.get("CONFIG_SALAS", RAIZ / "config" / "salas.yaml"))
FRONTEND = Path(os.environ.get("FRONTEND_DIR", RAIZ / "frontend"))
ZONA = ZoneInfo(os.environ.get("TZ", "UTC"))
DATO_VIEJO = timedelta(minutes=3)

servicio: Servicio  # se crea en lifespan()


def leer_salas_yaml() -> dict:
    """Lee y valida config/salas.yaml. Un error acá se ve apenas arranca el backend."""
    datos = yaml.safe_load(CONFIG.read_text(encoding="utf-8")) or {}
    salas = {}
    for sid, s in (datos.get("salas") or {}).items():
        config = ConfigSala.model_validate({"nombre": s.get("nombre", sid), "reles": s["reles"]})
        salas[sid] = {"config": config.model_dump(mode="json")}
    return salas


@asynccontextmanager
async def lifespan(app: FastAPI):
    global servicio
    pool = await db.conectar(os.environ["DATABASE_URL"])
    await db.inicializar(pool, leer_salas_yaml())
    servicio = Servicio(
        pool=pool,
        mqtt_host=os.environ.get("MQTT_HOST", "localhost"),
        mqtt_puerto=int(os.environ.get("MQTT_PUERTO", "1883")),
        mqtt_usuario=os.environ.get("MQTT_USUARIO") or None,
        mqtt_clave=os.environ.get("MQTT_CLAVE") or None,
    )
    await servicio.cargar_estado_inicial()
    tarea = asyncio.create_task(servicio.bucle_mqtt())
    yield
    tarea.cancel()
    await pool.close()


app = FastAPI(title="Salas de cultivo", lifespan=lifespan)


def _error_validacion(e: ValidationError) -> HTTPException:
    mensajes = [f"{'.'.join(map(str, err['loc']))}: {err['msg']}" for err in e.errors()]
    return HTTPException(422, "; ".join(mensajes))


async def _sala_o_404(sid: str):
    fila = await db.obtener_sala(servicio.pool, sid)
    if fila is None:
        raise HTTPException(404, f"No existe la sala {sid}")
    return fila


# --------------------------------------------------------------------- lectura

@app.get("/api/salas")
async def salas():
    """Todo lo que la pantalla principal necesita, de todas las salas, en una llamada."""
    ahora_utc = datetime.now(timezone.utc)
    ahora = ahora_utc.astimezone(ZONA)
    etapas = await db.etapas_actuales(servicio.pool)
    resultado = []
    for fila in await db.listar_salas(servicio.pool):
        sid, config = fila["id"], fila["config"]
        estado = servicio.salas.get(sid)
        lecturas = estado.lecturas if estado else {}
        reporte = estado.reporte if estado else {}

        reles = []
        for rid, r in config["reles"].items():
            real = estado.reles.get(rid, {}) if estado else {}
            regla = regla_adapter.validate_python(r["regla"])
            manual_vigente = r["modo"] == "manual" and (
                r["manual_hasta"] == 0 or r["manual_hasta"] > ahora_utc.timestamp())
            reles.append({
                "id": rid, **r,
                "manual_vigente": manual_vigente,
                "on": real.get("on"),
                "motivo": real.get("motivo") or "sin datos del módulo",
                "proximo": None if manual_vigente else proximo_cambio(regla, ahora),
            })

        etapa = etapas.get(sid)
        resultado.append({
            "id": sid,
            "nombre": config["nombre"],
            "etapa": etapa["etapa"] if etapa else None,
            "etapa_desde": etapa["fecha"] if etapa else None,
            "dia_etapa": (ahora_utc - etapa["fecha"]).days + 1 if etapa else None,
            "online": bool(estado and estado.online),
            "ultimo_dato": max((l.ts for l in lecturas.values()), default=None),
            "lecturas": {k: {"valor": l.valor, "ts": l.ts, "viejo": ahora_utc - l.ts > DATO_VIEJO}
                         for k, l in sorted(lecturas.items())},
            "reles": reles,
            "modulo": {
                "version_servidor": fila["version"],
                "version_aplicada": reporte.get("version"),
                "config_local": reporte.get("local", False),
                "modo_ap": reporte.get("ap", False),
                "hay_hora": reporte.get("hay_hora"),
                "pendientes": reporte.get("pendientes", 0),
                "error": reporte.get("error"),
            },
        })
    return {"mqtt_conectado": servicio.mqtt_conectado, "ahora": ahora_utc, "salas": resultado}


@app.get("/api/salas/{sid}/historico")
async def historico(sid: str, horas: float = Query(24, gt=0, le=24 * 120)):
    await _sala_o_404(sid)
    hasta = datetime.now(timezone.utc)
    desde = hasta - timedelta(hours=horas)
    segundos = max(30, int(horas * 3600 / 400))  # ~400 puntos por variable
    series: dict[str, list] = {}
    for f in await db.historico(servicio.pool, sid, desde, hasta, segundos):
        series.setdefault(f["variable"], []).append([f["t"], round(f["valor"], 3)])
    eventos = [dict(e) for e in await db.eventos(servicio.pool, sid, desde)]
    return {"desde": desde, "hasta": hasta, "series": series, "eventos": eventos}


# --------------------------------------------------------- cambios de config

async def _modificar(sid: str, cambio) -> dict:
    """Aplica `cambio` a la config de la sala, la valida, la guarda y la manda al ESP32."""
    fila = await _sala_o_404(sid)
    config = dict(fila["config"])
    cambio(config)
    try:
        valida = ConfigSala.model_validate(config).model_dump(mode="json")
    except ValidationError as e:
        raise _error_validacion(e)
    version = await db.guardar_config(servicio.pool, sid, valida)
    await servicio.publicar_config(sid)
    return {"ok": True, "version": version}


def _rele(config: dict, rid: str) -> dict:
    if rid not in config["reles"]:
        raise HTTPException(404, f"No existe el relé {rid}")
    return config["reles"][rid]


class PedidoManual(BaseModel):
    encendido: bool
    minutos: Optional[int] = Field(default=None, gt=0, le=7 * 24 * 60)  # None = sin límite


@app.post("/api/salas/{sid}/reles/{rid}/manual")
async def manual(sid: str, rid: str, pedido: PedidoManual):
    hasta = int(datetime.now(timezone.utc).timestamp()) + pedido.minutos * 60 if pedido.minutos else 0

    def cambio(config):
        r = _rele(config, rid)
        r.update(modo="manual", manual_estado=pedido.encendido, manual_hasta=hasta)
    return await _modificar(sid, cambio)


@app.post("/api/salas/{sid}/reles/{rid}/auto")
async def automatico(sid: str, rid: str):
    return await _modificar(sid, lambda config: _rele(config, rid).update(modo="auto", manual_hasta=0))


@app.put("/api/salas/{sid}/reles/{rid}/regla")
async def cambiar_regla(sid: str, rid: str, regla: dict):
    return await _modificar(sid, lambda config: _rele(config, rid).update(regla=regla))


class PedidoNombre(BaseModel):
    nombre: str = Field(min_length=1, max_length=40)


@app.put("/api/salas/{sid}/nombre")
async def renombrar(sid: str, pedido: PedidoNombre):
    return await _modificar(sid, lambda config: config.update(nombre=pedido.nombre))


# ------------------------------------------------------------------- bitácora

class EntradaBitacora(BaseModel):
    tipo: Literal[tuple(TIPOS_BITACORA)]
    etapa: Optional[Literal[tuple(ETAPAS)]] = None
    texto: str = Field(default="", max_length=2000)
    fecha: Optional[datetime] = None  # None = ahora

    @model_validator(mode="after")
    def _etapa_si_corresponde(self):
        if self.tipo == "etapa" and self.etapa is None:
            raise ValueError("un cambio de etapa necesita la etapa")
        if self.tipo != "etapa":
            self.etapa = None
        return self


@app.get("/api/salas/{sid}/bitacora")
async def ver_bitacora(sid: str):
    await _sala_o_404(sid)
    return [dict(f) for f in await db.bitacora(servicio.pool, sid)]


@app.post("/api/salas/{sid}/bitacora")
async def agregar_bitacora(sid: str, entrada: EntradaBitacora):
    await _sala_o_404(sid)
    fecha = entrada.fecha or datetime.now(timezone.utc)
    if fecha.tzinfo is None:
        fecha = fecha.replace(tzinfo=ZONA)  # fecha sin zona = hora local del servidor
    nuevo = await db.agregar_bitacora(servicio.pool, sid, fecha, entrada.tipo, entrada.etapa, entrada.texto)
    return {"ok": True, "id": nuevo}


@app.delete("/api/salas/{sid}/bitacora/{entrada}")
async def borrar_bitacora(sid: str, entrada: int):
    if not await db.borrar_bitacora(servicio.pool, sid, entrada):
        raise HTTPException(404, "No existe esa entrada")
    return {"ok": True}


# ------------------------------------------------------------------- frontend
# Va al final: las rutas /api/... de arriba tienen prioridad.
app.mount("/", StaticFiles(directory=FRONTEND, html=True), name="frontend")
