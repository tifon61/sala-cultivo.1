"""Motor de automatización: decide si cada relé tiene que estar prendido o apagado.

Todo lo de este archivo son funciones "puras": no tocan la base de datos ni MQTT.
Reciben el estado del mundo (hora, últimas mediciones, estado actual del relé)
y devuelven una Decisión. Eso las hace fáciles de entender y de probar
(ver backend/tests/test_automatizacion.py).
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, time, timedelta
from typing import Annotated, Literal, Optional, Union

from pydantic import BaseModel, Field, TypeAdapter, model_validator


# ---------------------------------------------------------------------------
# Reglas. Se guardan como JSON en la base y pydantic las valida al leerlas.
# El campo "tipo" indica cuál de las tres clases corresponde (discriminador).
# ---------------------------------------------------------------------------

class ReglaHorario(BaseModel):
    tipo: Literal["horario"]
    encender: time
    apagar: time


class ReglaUmbral(BaseModel):
    tipo: Literal["umbral"]
    variable: str
    encender_si: Literal["mayor", "menor"]
    valor: float
    histeresis: float = Field(default=0, ge=0)


class ReglaCiclo(BaseModel):
    tipo: Literal["ciclo"]
    inicio: time
    cada_min: int = Field(gt=0, le=1440)
    duracion_min: int = Field(gt=0)
    repeticiones: Optional[int] = Field(default=None, gt=0)

    @model_validator(mode="after")
    def _duracion_menor_que_periodo(self):
        if self.duracion_min > self.cada_min:
            raise ValueError("duracion_min no puede ser mayor que cada_min")
        return self


Regla = Annotated[Union[ReglaHorario, ReglaUmbral, ReglaCiclo], Field(discriminator="tipo")]
regla_adapter = TypeAdapter(Regla)


def leer_regla(datos: dict) -> Regla:
    """Convierte el JSON guardado en la base en un objeto Regla validado."""
    return regla_adapter.validate_python(datos)


# ---------------------------------------------------------------------------
# Entradas y salidas del motor
# ---------------------------------------------------------------------------

@dataclass
class Lectura:
    valor: float
    ts: datetime  # con zona horaria


@dataclass
class Decision:
    encendido: bool
    motivo: str  # texto para mostrar en la web: "por qué está así"


@dataclass
class Contexto:
    ahora: datetime                 # con zona horaria local (para horarios)
    lecturas: dict[str, Lectura]    # última lectura de cada variable
    max_edad_dato: timedelta        # más viejo que esto = "sin datos"


# ---------------------------------------------------------------------------
# Evaluación de cada tipo de regla
# ---------------------------------------------------------------------------

def en_ventana(hora: time, desde: time, hasta: time) -> bool:
    """¿Está `hora` dentro de [desde, hasta)? Soporta ventanas que cruzan medianoche.

    Si desde == hasta se considera "todo el día" (por ejemplo luz 24/0).
    """
    if desde == hasta:
        return True
    if desde < hasta:
        return desde <= hora < hasta
    return hora >= desde or hora < hasta  # ej. 18:00 -> 06:00


def _hhmm(t: time) -> str:
    return t.strftime("%H:%M")


def evaluar_horario(regla: ReglaHorario, ctx: Contexto) -> Decision:
    dentro = en_ventana(ctx.ahora.time(), regla.encender, regla.apagar)
    franja = f"{_hhmm(regla.encender)}–{_hhmm(regla.apagar)}"
    return Decision(dentro, f"horario {franja}: {'dentro' if dentro else 'fuera'}")


def evaluar_umbral(regla: ReglaUmbral, ctx: Contexto, encendido_actual: bool) -> Decision:
    lectura = ctx.lecturas.get(regla.variable)
    if lectura is None or ctx.ahora - lectura.ts > ctx.max_edad_dato:
        # Sin datos frescos no sabemos qué pasa: lo seguro es apagar.
        return Decision(False, f"sin datos recientes de {regla.variable}")

    v, limite, h = lectura.valor, regla.valor, regla.histeresis
    texto = f"{regla.variable} {v:g}"

    if regla.encender_si == "mayor":
        if v > limite:
            return Decision(True, f"{texto} > {limite:g}")
        if v < limite - h:
            return Decision(False, f"{texto} < {limite - h:g}")
    else:
        if v < limite:
            return Decision(True, f"{texto} < {limite:g}")
        if v > limite + h:
            return Decision(False, f"{texto} > {limite + h:g}")

    # Entre el umbral y el umbral ± histéresis: no cambiamos nada.
    return Decision(encendido_actual, f"{texto} en histéresis, se mantiene")


def evaluar_ciclo(regla: ReglaCiclo, ctx: Contexto) -> Decision:
    ahora = ctx.ahora
    minuto_actual = ahora.hour * 60 + ahora.minute + ahora.second / 60
    minuto_inicio = regla.inicio.hour * 60 + regla.inicio.minute
    # Minutos transcurridos desde la última vez que fue la hora de inicio.
    desde_inicio = (minuto_actual - minuto_inicio) % 1440
    numero_ciclo = int(desde_inicio // regla.cada_min)  # 0 = primer ciclo del día
    dentro_del_ciclo = desde_inicio % regla.cada_min

    if regla.repeticiones is not None and numero_ciclo >= regla.repeticiones:
        return Decision(False, f"ciclo: ya hizo las {regla.repeticiones} repeticiones de hoy")
    if dentro_del_ciclo < regla.duracion_min:
        return Decision(True, f"ciclo: encendido {regla.duracion_min} min cada {regla.cada_min} min")
    return Decision(False, f"ciclo: en pausa (cada {regla.cada_min} min)")


def evaluar_regla(regla: Regla, ctx: Contexto, encendido_actual: bool) -> Decision:
    if isinstance(regla, ReglaHorario):
        return evaluar_horario(regla, ctx)
    if isinstance(regla, ReglaUmbral):
        return evaluar_umbral(regla, ctx, encendido_actual)
    return evaluar_ciclo(regla, ctx)


# ---------------------------------------------------------------------------
# Decisión final de un relé: el modo manual tiene prioridad sobre la regla.
# ---------------------------------------------------------------------------

def manual_vigente(modo: str, manual_hasta: Optional[datetime], ahora: datetime) -> bool:
    return modo == "manual" and (manual_hasta is None or ahora < manual_hasta)


def decidir(
    modo: str,
    manual_estado: bool,
    manual_hasta: Optional[datetime],
    regla: Regla,
    ctx: Contexto,
    encendido_actual: bool,
) -> Decision:
    if manual_vigente(modo, manual_hasta, ctx.ahora):
        accion = "encendido" if manual_estado else "apagado"
        if manual_hasta is None:
            return Decision(manual_estado, f"manual: {accion}")
        hasta = manual_hasta.astimezone(ctx.ahora.tzinfo)
        return Decision(manual_estado, f"manual: {accion} hasta {hasta:%H:%M}")
    return evaluar_regla(regla, ctx, encendido_actual)
