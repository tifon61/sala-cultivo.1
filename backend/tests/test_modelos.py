"""Pruebas de validación y de "próximo cambio". Correr con:  cd backend && pytest"""
from datetime import datetime
from zoneinfo import ZoneInfo

import pytest
from pydantic import ValidationError

from app.modelos import ConfigSala, proximo_cambio, regla_adapter

ZONA = ZoneInfo("America/Argentina/Buenos_Aires")


def a_las(h, m, s=0):
    return datetime(2026, 10, 17, h, m, s, tzinfo=ZONA)


def regla(**datos):
    return regla_adapter.validate_python(datos)


# --- validación -------------------------------------------------------------

@pytest.mark.parametrize("datos", [
    {"tipo": "horario", "encender": "25:00", "apagar": "06:00"},
    {"tipo": "horario", "encender": "6:00", "apagar": "18:00"},          # falta el cero
    {"tipo": "pulsos", "encendido_s": 600, "cada_min": 5},              # pulso > período
    {"tipo": "pulsos", "encendido_s": 30, "cada_min": 60, "desde": "08:00"},  # ventana incompleta
    {"tipo": "umbral", "variable": "dpv", "encender_si": "igual", "valor": 1},
    {"tipo": "magia"},
])
def test_reglas_invalidas(datos):
    with pytest.raises(ValidationError):
        regla(**datos)


def test_config_sala_valida():
    c = ConfigSala.model_validate({"nombre": "Sala 1", "reles": {
        "riego": {"nombre": "Riego", "regla": {"tipo": "pulsos", "encendido_s": 30, "cada_min": 120}}}})
    assert c.reles["riego"].modo == "auto"


# --- próximo cambio de la luz -------------------------------------------------

LUZ_12_12 = dict(tipo="horario", encender="20:00", apagar="08:00")


def test_luz_prendida_dice_cuando_se_apaga():
    p = proximo_cambio(regla(**LUZ_12_12), a_las(23, 0))
    assert p["texto"] == "se apaga a las 08:00"
    assert p["cuando"] == datetime(2026, 10, 18, 8, 0, tzinfo=ZONA)


def test_luz_apagada_dice_cuando_se_prende():
    p = proximo_cambio(regla(**LUZ_12_12), a_las(9, 0))
    assert p["texto"] == "se prende a las 20:00"
    assert p["cuando"] == a_las(20, 0)


def test_luz_24h_no_tiene_cambio():
    assert proximo_cambio(regla(tipo="horario", encender="00:00", apagar="00:00"), a_las(9, 0)) is None


# --- próximo riego ------------------------------------------------------------

RIEGO = dict(tipo="pulsos", encendido_s=30, cada_min=120, desde="08:00", hasta="20:00")


@pytest.mark.parametrize("ahora, texto, cuando", [
    (a_las(7, 0), "próximo riego a las 08:00", a_las(8, 0)),
    (a_las(8, 0, 10), "regando (30 s)", a_las(8, 0, 30)),
    (a_las(9, 15), "próximo riego a las 10:00", a_las(10, 0)),
    (a_las(18, 1), "próximo riego a las 08:00", datetime(2026, 10, 18, 8, 0, tzinfo=ZONA)),  # 20:00 queda fuera
])
def test_proximo_riego(ahora, texto, cuando):
    p = proximo_cambio(regla(**RIEGO), ahora)
    assert p["texto"] == texto and p["cuando"] == cuando


def test_riego_sin_ventana_cuenta_desde_medianoche():
    p = proximo_cambio(regla(tipo="pulsos", encendido_s=20, cada_min=90), a_las(1, 0))
    assert p["cuando"] == a_las(1, 30)


def test_umbral_no_tiene_proximo():
    assert proximo_cambio(regla(tipo="umbral", variable="dpv", encender_si="mayor", valor=1.2), a_las(9, 0)) is None
