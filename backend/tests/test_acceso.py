"""Pruebas de la clave de la web. Correr con:  cd backend && pytest"""
import time

from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.acceso import COOKIE, MAX_FALLOS, Acceso, crear_token, token_valido


def test_token_firmado():
    t = crear_token("secreta")
    assert token_valido("secreta", t)
    assert not token_valido("otra", t)                      # cambiar la clave invalida sesiones
    vence, firma = t.split(".")
    assert not token_valido("secreta", f"{int(vence) + 999}.{firma}")  # no se puede alargar
    assert not token_valido("secreta", None)
    assert not token_valido("secreta", "basura")


def test_token_vencido():
    viejo = crear_token("secreta", ahora=time.time() - 31 * 24 * 3600)
    assert not token_valido("secreta", viejo)


def cliente(clave):
    acceso = Acceso(clave)
    app = FastAPI()
    app.middleware("http")(acceso.middleware)

    @app.get("/api/datos")
    def datos():
        return {"ok": True}

    @app.get("/")
    def inicio():
        return {"pagina": True}

    @app.get("/login.html")
    def login():
        return {"login": True}

    return TestClient(app), acceso


def test_sin_cookie_api_401_y_paginas_al_login():
    c, _ = cliente("secreta")
    assert c.get("/api/datos").status_code == 401
    r = c.get("/", follow_redirects=False)
    assert r.status_code == 303 and r.headers["location"] == "/login.html"
    assert c.get("/login.html").status_code == 200


def test_con_cookie_valida_entra():
    c, _ = cliente("secreta")
    c.cookies.set(COOKIE, crear_token("secreta"))
    assert c.get("/api/datos").json() == {"ok": True}


def test_sin_clave_configurada_no_pide_nada():
    c, _ = cliente("")
    assert c.get("/api/datos").status_code == 200


def test_bloqueo_por_intentos_fallidos():
    _, acceso = cliente("secreta")
    for _ in range(MAX_FALLOS):
        assert not acceso.verificar("1.2.3.4", "mal")
    assert acceso.bloqueada("1.2.3.4")
    assert not acceso.bloqueada("5.6.7.8")  # otra IP no se ve afectada
