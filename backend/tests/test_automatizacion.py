"""Pruebas del motor de automatización. Correr con:  cd backend && pytest"""
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

import pytest
from pydantic import ValidationError

from app.automatizacion import (
    Contexto,
    Lectura,
    decidir,
    en_ventana,
    evaluar_ciclo,
    evaluar_horario,
    evaluar_umbral,
    leer_regla,
)

ZONA = ZoneInfo("America/Argentina/Buenos_Aires")


def ctx_a(hora: str, lecturas=None, edad_dato_min=0) -> Contexto:
    h, m = map(int, hora.split(":"))
    ahora = datetime(2026, 10, 17, h, m, tzinfo=ZONA)
    lect = {k: Lectura(v, ahora - timedelta(minutes=edad_dato_min)) for k, v in (lecturas or {}).items()}
    return Contexto(ahora=ahora, lecturas=lect, max_edad_dato=timedelta(minutes=3))


# --- horario ---------------------------------------------------------------

def test_ventana_que_cruza_medianoche():
    regla = leer_regla({"tipo": "horario", "encender": "18:00", "apagar": "06:00"})
    assert evaluar_horario(regla, ctx_a("23:00")).encendido
    assert evaluar_horario(regla, ctx_a("05:59")).encendido
    assert not evaluar_horario(regla, ctx_a("06:00")).encendido
    assert not evaluar_horario(regla, ctx_a("12:00")).encendido


def test_luz_18_6_apaga_a_medianoche():
    regla = leer_regla({"tipo": "horario", "encender": "06:00", "apagar": "00:00"})
    assert evaluar_horario(regla, ctx_a("06:00")).encendido
    assert evaluar_horario(regla, ctx_a("23:59")).encendido
    assert not evaluar_horario(regla, ctx_a("00:00")).encendido
    assert not evaluar_horario(regla, ctx_a("03:00")).encendido


def test_misma_hora_es_todo_el_dia():
    from datetime import time
    assert en_ventana(time(3, 0), time(0, 0), time(0, 0))


# --- umbral ----------------------------------------------------------------

EXTRACTOR = leer_regla({"tipo": "umbral", "variable": "temperatura",
                        "encender_si": "mayor", "valor": 28, "histeresis": 1.5})
HUMIDIFICADOR = leer_regla({"tipo": "umbral", "variable": "humedad",
                            "encender_si": "menor", "valor": 55, "histeresis": 5})


@pytest.mark.parametrize("temp, actual, esperado", [
    (29.0, False, True),    # supera el umbral: prende
    (27.0, True, True),     # en histéresis: sigue prendido
    (27.0, False, False),   # en histéresis: sigue apagado
    (26.4, True, False),    # bajó de 28 - 1.5: apaga
])
def test_umbral_mayor_con_histeresis(temp, actual, esperado):
    d = evaluar_umbral(EXTRACTOR, ctx_a("12:00", {"temperatura": temp}), actual)
    assert d.encendido is esperado


@pytest.mark.parametrize("hum, actual, esperado", [
    (50, False, True),
    (58, True, True),
    (61, True, False),
])
def test_umbral_menor(hum, actual, esperado):
    d = evaluar_umbral(HUMIDIFICADOR, ctx_a("12:00", {"humedad": hum}), actual)
    assert d.encendido is esperado


def test_umbral_sin_datos_apaga():
    assert not evaluar_umbral(EXTRACTOR, ctx_a("12:00"), True).encendido
    viejo = ctx_a("12:00", {"temperatura": 35}, edad_dato_min=10)
    d = evaluar_umbral(EXTRACTOR, viejo, True)
    assert not d.encendido and "sin datos" in d.motivo


# --- ciclo -----------------------------------------------------------------

RIEGO = leer_regla({"tipo": "ciclo", "inicio": "09:00", "cada_min": 480,
                    "duracion_min": 2, "repeticiones": 2})


@pytest.mark.parametrize("hora, esperado", [
    ("08:59", False),
    ("09:00", True),
    ("09:01", True),
    ("09:02", False),
    ("17:00", True),   # segunda repetición
    ("17:03", False),
    ("01:00", False),  # sería la tercera: no corresponde
])
def test_ciclo_con_repeticiones(hora, esperado):
    assert evaluar_ciclo(RIEGO, ctx_a(hora)).encendido is esperado


def test_ciclo_invalido():
    with pytest.raises(ValidationError):
        leer_regla({"tipo": "ciclo", "inicio": "09:00", "cada_min": 5, "duracion_min": 10})


# --- manual ----------------------------------------------------------------

def test_manual_tiene_prioridad_y_vence():
    ctx = ctx_a("12:00", {"temperatura": 35})
    hasta = ctx.ahora + timedelta(minutes=15)
    d = decidir("manual", False, hasta, EXTRACTOR, ctx, True)
    assert not d.encendido and "manual" in d.motivo

    vencido = ctx.ahora - timedelta(minutes=1)
    d = decidir("manual", False, vencido, EXTRACTOR, ctx, True)
    assert d.encendido  # volvió a la regla automática


def test_manual_sin_limite():
    d = decidir("manual", True, None, EXTRACTOR, ctx_a("12:00", {"temperatura": 20}), False)
    assert d.encendido
