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
-- Formato "largo": una fila por (momento, variable). Agregar un sensor nuevo
-- no requiere cambiar la tabla: el ESP32 manda otra clave en el JSON y listo.
CREATE TABLE IF NOT EXISTS mediciones (
    ts          timestamptz      NOT NULL DEFAULT now(),
    dispositivo text             NOT NULL,
    variable    text             NOT NULL,
    valor       double precision NOT NULL
);
CREATE INDEX IF NOT EXISTS mediciones_variable_ts ON mediciones (variable, ts DESC);
CREATE INDEX IF NOT EXISTS mediciones_ts ON mediciones (ts);

-- Configuración de cada relé: modo (auto/manual) y su regla automática.
CREATE TABLE IF NOT EXISTS reles (
    id            text        PRIMARY KEY,
    nombre        text        NOT NULL,
    orden         int         NOT NULL DEFAULT 0,
    modo          text        NOT NULL DEFAULT 'auto' CHECK (modo IN ('auto', 'manual')),
    manual_estado boolean     NOT NULL DEFAULT false,
    manual_hasta  timestamptz,
    regla         jsonb       NOT NULL
);

-- Historial: cada vez que el sistema decide cambiar un relé queda registrado.
CREATE TABLE IF NOT EXISTS eventos_reles (
    ts     timestamptz NOT NULL DEFAULT now(),
    rele   text        NOT NULL,
    estado boolean     NOT NULL,
    motivo text
);
CREATE INDEX IF NOT EXISTS eventos_reles_ts ON eventos_reles (ts DESC);
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


async def inicializar(pool: asyncpg.Pool, reles_iniciales: dict) -> None:
    """Crea las tablas y agrega los relés de sala.yaml que todavía no existan."""
    async with pool.acquire() as conn:
        await conn.execute(ESQUEMA)
        for orden, (rid, datos) in enumerate(reles_iniciales.items()):
            await conn.execute(
                """INSERT INTO reles (id, nombre, orden, regla) VALUES ($1, $2, $3, $4)
                   ON CONFLICT (id) DO NOTHING""",
                rid, datos.get("nombre", rid), orden, datos["regla"],
            )


# --- mediciones ------------------------------------------------------------

async def guardar_mediciones(pool, ts: datetime, dispositivo: str, valores: dict[str, float]) -> None:
    await pool.executemany(
        "INSERT INTO mediciones (ts, dispositivo, variable, valor) VALUES ($1, $2, $3, $4)",
        [(ts, dispositivo, var, val) for var, val in valores.items()],
    )


async def ultimas_lecturas(pool) -> list[asyncpg.Record]:
    # DISTINCT ON se queda con la primera fila de cada variable según el ORDER BY,
    # o sea la más reciente.
    return await pool.fetch(
        """SELECT DISTINCT ON (variable) variable, valor, ts
           FROM mediciones ORDER BY variable, ts DESC"""
    )


async def historico(pool, desde: datetime, hasta: datetime, segundos_por_punto: int) -> list[asyncpg.Record]:
    """Promedia las mediciones en intervalos (date_bin) para no mandar miles de puntos."""
    return await pool.fetch(
        """SELECT variable,
                  date_bin(make_interval(secs => $3), ts, TIMESTAMPTZ '2000-01-01') AS t,
                  avg(valor) AS valor
           FROM mediciones
           WHERE ts >= $1 AND ts < $2
           GROUP BY variable, t
           ORDER BY variable, t""",
        desde, hasta, segundos_por_punto,
    )


# --- relés -----------------------------------------------------------------

async def listar_reles(pool) -> list[asyncpg.Record]:
    return await pool.fetch("SELECT * FROM reles ORDER BY orden, id")


async def poner_manual(pool, rid: str, estado: bool, hasta: Optional[datetime]) -> bool:
    r = await pool.execute(
        "UPDATE reles SET modo='manual', manual_estado=$2, manual_hasta=$3 WHERE id=$1",
        rid, estado, hasta,
    )
    return r.endswith(" 1")


async def poner_auto(pool, rid: str) -> bool:
    r = await pool.execute("UPDATE reles SET modo='auto', manual_hasta=NULL WHERE id=$1", rid)
    return r.endswith(" 1")


async def guardar_regla(pool, rid: str, regla: dict) -> bool:
    r = await pool.execute("UPDATE reles SET regla=$2 WHERE id=$1", rid, regla)
    return r.endswith(" 1")


async def registrar_evento(pool, rid: str, estado: bool, motivo: str) -> None:
    await pool.execute(
        "INSERT INTO eventos_reles (rele, estado, motivo) VALUES ($1, $2, $3)", rid, estado, motivo
    )


async def ultimo_estado_reles(pool) -> list[asyncpg.Record]:
    return await pool.fetch(
        "SELECT DISTINCT ON (rele) rele, estado, motivo FROM eventos_reles ORDER BY rele, ts DESC"
    )


async def eventos(pool, desde: datetime, limite: int = 200) -> list[asyncpg.Record]:
    return await pool.fetch(
        "SELECT ts, rele, estado, motivo FROM eventos_reles WHERE ts >= $1 ORDER BY ts DESC LIMIT $2",
        desde, limite,
    )
