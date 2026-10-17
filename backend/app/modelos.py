"""Forma de la configuración de cada sala (la misma que entiende el ESP32)
y cálculo de "qué pasa después" para mostrar en el esquema.

Las reglas se EJECUTAN en el ESP32 (firmware/src/reglas.cpp). Acá solo se
validan antes de mandarlas y se calcula el próximo cambio para la pantalla.
"""
from __future__ import annotations

from datetime import datetime, timedelta
from typing import Annotated, Literal, Optional, Union

from pydantic import BaseModel, Field, TypeAdapter, model_validator

Hora = Annotated[str, Field(pattern=r"^([01]\d|2[0-3]):[0-5]\d$")]  # "HH:MM"


class ReglaHorario(BaseModel):
    tipo: Literal["horario"]
    encender: Hora
    apagar: Hora


class ReglaUmbral(BaseModel):
    tipo: Literal["umbral"]
    variable: str = Field(min_length=1, max_length=15)
    encender_si: Literal["mayor", "menor"]
    valor: float
    histeresis: float = Field(default=0, ge=0)


class ReglaPulsos(BaseModel):
    tipo: Literal["pulsos"]
    encendido_s: int = Field(gt=0, le=3600)
    cada_min: int = Field(gt=0, le=1440)
    desde: Optional[Hora] = None   # ventana del día en que se permite regar
    hasta: Optional[Hora] = None

    @model_validator(mode="after")
    def _coherente(self):
        if self.encendido_s > self.cada_min * 60:
            raise ValueError("el pulso no puede durar más que el período")
        if (self.desde is None) != (self.hasta is None):
            raise ValueError("la ventana necesita 'desde' y 'hasta'")
        return self


Regla = Annotated[Union[ReglaHorario, ReglaUmbral, ReglaPulsos], Field(discriminator="tipo")]
regla_adapter = TypeAdapter(Regla)


class ConfigRele(BaseModel):
    nombre: str
    modo: Literal["auto", "manual"] = "auto"
    manual_estado: bool = False
    manual_hasta: int = 0          # epoch UTC en segundos; 0 = sin límite
    regla: Regla


class ConfigSala(BaseModel):
    nombre: str
    reles: dict[str, ConfigRele]


ETAPAS = ["germinacion", "plantines", "vegetativo", "floracion", "secado", "curado", "vacia"]
TIPOS_BITACORA = ["etapa", "nota", "riego_nutrientes", "poda", "trasplante", "plaga", "cosecha", "mantenimiento"]


# ---------------------------------------------------------------------------
# Próximo cambio (solo informativo: lo que de verdad decide es el ESP32)
# ---------------------------------------------------------------------------

def _minutos(hhmm: str) -> int:
    h, m = hhmm.split(":")
    return int(h) * 60 + int(m)


def _a_las(ahora: datetime, minutos: int) -> datetime:
    return ahora.replace(hour=minutos // 60, minute=minutos % 60, second=0, microsecond=0)


def _en_ventana(minuto_del_dia: float, desde: int, hasta: int) -> bool:
    if desde == hasta:
        return True
    if desde < hasta:
        return desde <= minuto_del_dia < hasta
    return minuto_del_dia >= desde or minuto_del_dia < hasta


def proximo_cambio(regla, ahora: datetime) -> Optional[dict]:
    """Devuelve {"texto", "cuando"} con el próximo evento previsible, o None."""
    if isinstance(regla, ReglaHorario):
        e, a = _minutos(regla.encender), _minutos(regla.apagar)
        if e == a:
            return None
        minuto = ahora.hour * 60 + ahora.minute + ahora.second / 60
        prendida = _en_ventana(minuto, e, a)
        objetivo = _a_las(ahora, a if prendida else e)
        if objetivo <= ahora:
            objetivo += timedelta(days=1)
        hora = regla.apagar if prendida else regla.encender
        return {"texto": f"{'se apaga' if prendida else 'se prende'} a las {hora}", "cuando": objetivo}

    if isinstance(regla, ReglaPulsos):
        desde = _minutos(regla.desde) if regla.desde else 0
        hasta = _minutos(regla.hasta) if regla.hasta else desde
        largo_ventana = ((hasta - desde) % 1440 or 1440) * 60
        periodo = regla.cada_min * 60
        base_hoy = _a_las(ahora, desde)
        # Mismo cálculo que el ESP32: pulsos cada `periodo` desde el inicio de la ventana.
        for base in (base_hoy - timedelta(days=1), base_hoy, base_hoy + timedelta(days=1)):
            k = 0
            while k * periodo < largo_ventana:
                inicio = base + timedelta(seconds=k * periodo)
                fin = inicio + timedelta(seconds=regla.encendido_s)
                if fin > ahora:
                    if inicio <= ahora:
                        return {"texto": f"regando ({regla.encendido_s} s)", "cuando": fin}
                    return {"texto": f"próximo riego a las {inicio:%H:%M}", "cuando": inicio}
                k += 1
    return None
