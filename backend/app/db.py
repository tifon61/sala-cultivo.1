"""Acceso a Postgres con asyncpg (SQL directo, sin ORM, para que se vea qué pasa)."""
from __future__ import annotations

import asyncio
import json
import logging
from datetime import datetime
from typing import Optional

import asyncpg

log = logging.getLogger(__name__)

ESQUEMA = """
-- Una fila por sala. "config" es exactamente el JSON que se le manda al ESP32.
-- "version" sube con cada cambio: así sabemos si el ESP32 ya tiene la última.
CREATE TABLE IF NOT EXISTS salas (
    id      text  PRIMARY KEY,
    orden   int   NOT NULL DEFAULT 0,
    config  jsonb NOT NULL,
    version int   NOT NULL DEFAULT 1
);

-- Formato "largo": una fila por (momento, sala, variable). Agregar un sensor
-- no requiere cambiar la tabla.
CREATE TABLE IF NOT EXISTS mediciones (
    ts          timestamptz      NOT NULL,
    dispositivo text             NOT NULL,
    variable    text             NOT NULL,
    valor       double precision NOT NULL
);
CREATE INDEX IF NOT EXISTS mediciones_sala_ts ON mediciones (dispositivo, ts);

-- Cada vez que el ESP32 informa que un relé cambió.
CREATE TABLE IF NOT EXISTS eventos_reles (
    ts          timestamptz NOT NULL DEFAULT now(),
    dispositivo text        NOT NULL,
    rele        text        NOT NULL,
    estado      boolean     NOT NULL,
    motivo      text
);
CREATE INDEX IF NOT EXISTS eventos_reles_sala_ts ON eventos_reles (dispositivo, ts DESC);

-- Bitácora de cultivo: cambios de etapa, notas, podas, cosecha...
-- La etapa actual de una sala es la última entrada de tipo 'etapa'.
CREATE TABLE IF NOT EXISTS bitacora (
    id     serial      PRIMARY KEY,
    sala   text        NOT NULL REFERENCES salas(id),
    fecha  timestamptz NOT NULL,          -- cuándo pasó (se puede cargar a posteriori)
    tipo   text        NOT NULL,
    etapa  text,                          -- solo para tipo 'etapa'
    texto  text        NOT NULL DEFAULT '',
    creado timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS bitacora_sala_fecha ON bitacora (sala, fecha DESC);
"""


async def _codec_json(conn: asyncpg.Connection) -> None:
    # Que las columnas jsonb lleguen a Python como dict (y no como texto).
    await conn.set_type_codec("jsonb", encoder=json.dumps, decoder=json.loads, schema="pg_catalog")


async def conectar(url: str) -> asyncpg.Pool:
    for intento in range(1, 31):
        try:
            return await asyncpg.create_pool(url, min_size=1, max_size=5, init=_codec_json)
        except (OSError, asyncpg.PostgresError) as e:
            log.warning("Postgres no disponible (intento %d): %s", intento, e)
            await asyncio.sleep(2)
    raise RuntimeError("No se pudo conectar a Postgres")


async def inicializar(pool: asyncpg.Pool, salas_iniciales: dict) -> None:
    """Crea las tablas y agrega las salas de salas.yaml que todavía no existan."""
    async with pool.acquire() as conn:
        await conn.execute(ESQUEMA)
        for orden, (sid, datos) in enumerate(salas_iniciales.items()):
            await conn.execute(
                "INSERT INTO salas (id, orden, config) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING",
                sid, orden, datos["config"],
            )


# --- salas -------------------------------------------------------------------

async def listar_salas(pool) -> list[asyncpg.Record]:
    return await pool.fetch("SELECT id, config, version FROM salas ORDER BY orden, id")


async def obtener_sala(pool, sid: str) -> Optional[asyncpg.Record]:
    return await pool.fetchrow("SELECT id, config, version FROM salas WHERE id=$1", sid)


async def guardar_config(pool, sid: str, config: dict) -> int:
    """Guarda la config y devuelve la versión nueva."""
    return await pool.fetchval(
        "UPDATE salas SET config=$2, version=version+1 WHERE id=$1 RETURNING version", sid, config
    )


# --- mediciones ----------------------------------------------------------------

async def guardar_mediciones(pool, ts: datetime, dispositivo: str, valores: dict[str, float]) -> None:
    await pool.executemany(
        "INSERT INTO mediciones (ts, dispositivo, variable, valor) VALUES ($1, $2, $3, $4)",
        [(ts, dispositivo, var, val) for var, val in valores.items()],
    )


async def ultimas_lecturas(pool) -> list[asyncpg.Record]:
    # DISTINCT ON se queda con la primera fila de cada grupo según el ORDER BY: la más reciente.
    return await pool.fetch(
        """SELECT DISTINCT ON (dispositivo, variable) dispositivo, variable, valor, ts
           FROM mediciones WHERE ts > now() - interval '1 day'
           ORDER BY dispositivo, variable, ts DESC"""
    )


async def historico(pool, sala: str, desde: datetime, hasta: datetime, segundos: int) -> list[asyncpg.Record]:
    """Promedia las mediciones en intervalos (date_bin) para no mandar miles de puntos."""
    return await pool.fetch(
        """SELECT variable,
                  date_bin(make_interval(secs => $4), ts, TIMESTAMPTZ '2000-01-01') AS t,
                  avg(valor) AS valor
           FROM mediciones
           WHERE dispositivo = $1 AND ts >= $2 AND ts < $3
           GROUP BY variable, t
           ORDER BY variable, t""",
        sala, desde, hasta, segundos,
    )


# --- eventos de relés --------------------------------------------------------------

async def registrar_evento(pool, sala: str, rele: str, estado: bool, motivo: str) -> None:
    await pool.execute(
        "INSERT INTO eventos_reles (dispositivo, rele, estado, motivo) VALUES ($1, $2, $3, $4)",
        sala, rele, estado, motivo,
    )


async def ultimo_estado_reles(pool) -> list[asyncpg.Record]:
    return await pool.fetch(
        """SELECT DISTINCT ON (dispositivo, rele) dispositivo, rele, estado
           FROM eventos_reles ORDER BY dispositivo, rele, ts DESC"""
    )


async def eventos(pool, sala: str, desde: datetime, limite: int = 100) -> list[asyncpg.Record]:
    return await pool.fetch(
        """SELECT ts, rele, estado, motivo FROM eventos_reles
           WHERE dispositivo = $1 AND ts >= $2 ORDER BY ts DESC LIMIT $3""",
        sala, desde, limite,
    )


# --- bitácora ----------------------------------------------------------------------

async def etapas_actuales(pool) -> dict[str, asyncpg.Record]:
    filas = await pool.fetch(
        """SELECT DISTINCT ON (sala) sala, etapa, fecha FROM bitacora
           WHERE tipo = 'etapa' AND fecha <= now() ORDER BY sala, fecha DESC, id DESC"""
    )
    return {f["sala"]: f for f in filas}


async def bitacora(pool, sala: str, limite: int = 200) -> list[asyncpg.Record]:
    return await pool.fetch(
        "SELECT id, fecha, tipo, etapa, texto FROM bitacora WHERE sala=$1 ORDER BY fecha DESC, id DESC LIMIT $2",
        sala, limite,
    )


async def agregar_bitacora(pool, sala: str, fecha: datetime, tipo: str, etapa: Optional[str], texto: str) -> int:
    return await pool.fetchval(
        "INSERT INTO bitacora (sala, fecha, tipo, etapa, texto) VALUES ($1, $2, $3, $4, $5) RETURNING id",
        sala, fecha, tipo, etapa, texto,
    )


async def borrar_bitacora(pool, sala: str, entrada: int) -> bool:
    r = await pool.execute("DELETE FROM bitacora WHERE id=$1 AND sala=$2", entrada, sala)
    return r.endswith(" 1")
