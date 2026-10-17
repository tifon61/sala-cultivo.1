"""API web (FastAPI). También sirve la página del celular desde /frontend.

Arranque: conecta a Postgres, crea tablas, y lanza dos tareas en segundo plano:
el bucle MQTT (escuchar al ESP32) y el bucle de automatización (decidir relés).
"""
from __future__ import annotations

import asyncio
import logging
import os
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Optional
from zoneinfo import ZoneInfo

import yaml
from fastapi import FastAPI, HTTPException, Query
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field, ValidationError

from . import db
from .automatizacion import Regla, regla_adapter
from .servicio import Servicio

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")

RAIZ = Path(__file__).resolve().parent.parent
CONFIG = Path(os.environ.get("CONFIG_SALA", RAIZ / "config" / "sala.yaml"))
FRONTEND = Path(os.environ.get("FRONTEND_DIR", RAIZ / "frontend"))

servicio: Servicio  # se crea en lifespan()


@asynccontextmanager
async def lifespan(app: FastAPI):
    global servicio
    config = yaml.safe_load(CONFIG.read_text(encoding="utf-8")) or {}
    reles = config.get("reles", {})
    for rid, datos in reles.items():  # que un error en sala.yaml se vea al arrancar
        regla_adapter.validate_python(datos["regla"])

    pool = await db.conectar(os.environ["DATABASE_URL"])
    await db.inicializar(pool, reles)

    servicio = Servicio(
        pool=pool,
        dispositivo=os.environ.get("DISPOSITIVO", "sala1"),
        zona=ZoneInfo(os.environ.get("TZ", "UTC")),
        mqtt_host=os.environ.get("MQTT_HOST", "localhost"),
        mqtt_puerto=int(os.environ.get("MQTT_PUERTO", "1883")),
        mqtt_usuario=os.environ.get("MQTT_USUARIO") or None,
        mqtt_clave=os.environ.get("MQTT_CLAVE") or None,
    )
    await servicio.cargar_estado_inicial()
    tareas = [
        asyncio.create_task(servicio.bucle_mqtt()),
        asyncio.create_task(servicio.bucle_automatizacion()),
    ]
    yield
    for t in tareas:
        t.cancel()
    await pool.close()


app = FastAPI(title="Sala de cultivo", lifespan=lifespan)


# --------------------------------------------------------------------- lectura

@app.get("/api/estado")
async def estado():
    """Todo lo que la pantalla principal necesita, en una sola llamada."""
    filas = await db.listar_reles(servicio.pool)
    reles = []
    for f in filas:
        e = servicio.reles.get(f["id"])
        reles.append({
            "id": f["id"],
            "nombre": f["nombre"],
            "modo": f["modo"],
            "manual_estado": f["manual_estado"],
            "manual_hasta": f["manual_hasta"],
            "regla": f["regla"],
            "encendido": e.deseado if e else None,
            "reportado": e.reportado if e else None,
            "motivo": e.motivo if e else "sin evaluar",
        })
    ultimo = max((l.ts for l in servicio.lecturas.values()), default=None)
    return {
        "dispositivo": servicio.dispositivo,
        "online": servicio.online,
        "mqtt_conectado": servicio.mqtt_conectado,
        "ultimo_dato": ultimo,
        "lecturas": {k: {"valor": l.valor, "ts": l.ts} for k, l in sorted(servicio.lecturas.items())},
        "reles": reles,
    }


@app.get("/api/historico")
async def historico(horas: float = Query(24, gt=0, le=24 * 90)):
    hasta = datetime.now(timezone.utc)
    desde = hasta - timedelta(hours=horas)
    # Apuntamos a ~400 puntos por variable, nunca menos de 30 s por punto.
    segundos = max(30, int(horas * 3600 / 400))
    series: dict[str, list] = {}
    for f in await db.historico(servicio.pool, desde, hasta, segundos):
        series.setdefault(f["variable"], []).append([f["t"], round(f["valor"], 3)])
    eventos = [dict(e) for e in await db.eventos(servicio.pool, desde)]
    return {"desde": desde, "hasta": hasta, "segundos_por_punto": segundos,
            "series": series, "eventos": eventos}


# ---------------------------------------------------------------- control relés

class PedidoManual(BaseModel):
    encendido: bool
    minutos: Optional[int] = Field(default=None, gt=0, le=7 * 24 * 60)  # None = sin límite


@app.post("/api/reles/{rid}/manual")
async def manual(rid: str, pedido: PedidoManual):
    hasta = None
    if pedido.minutos:
        hasta = datetime.now(timezone.utc) + timedelta(minutes=pedido.minutos)
    if not await db.poner_manual(servicio.pool, rid, pedido.encendido, hasta):
        raise HTTPException(404, f"No existe el relé {rid}")
    servicio.reevaluar_ya()
    return {"ok": True}


@app.post("/api/reles/{rid}/auto")
async def automatico(rid: str):
    if not await db.poner_auto(servicio.pool, rid):
        raise HTTPException(404, f"No existe el relé {rid}")
    servicio.reevaluar_ya()
    return {"ok": True}


@app.put("/api/reles/{rid}/regla")
async def cambiar_regla(rid: str, regla: dict):
    try:
        valida: Regla = regla_adapter.validate_python(regla)
    except ValidationError as e:
        mensajes = [f"{'.'.join(map(str, err['loc']))}: {err['msg']}" for err in e.errors()]
        raise HTTPException(422, "; ".join(mensajes))
    if not await db.guardar_regla(servicio.pool, rid, valida.model_dump(mode="json")):
        raise HTTPException(404, f"No existe el relé {rid}")
    servicio.reevaluar_ya()
    return {"ok": True, "regla": valida.model_dump(mode="json")}


# ------------------------------------------------------------------- frontend
# Va al final: las rutas /api/... de arriba tienen prioridad.
app.mount("/", StaticFiles(directory=FRONTEND, html=True), name="frontend")
