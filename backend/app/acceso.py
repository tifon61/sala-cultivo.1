"""Clave para entrar a la web.

Cómo funciona:
  1. La página /login.html manda la clave a POST /api/login.
  2. Si es correcta, el servidor responde con una cookie "sesion" firmada
     (HMAC): contiene la fecha de vencimiento y una firma que solo el servidor
     sabe calcular. Nadie puede fabricarla ni alargarla sin conocer la clave.
  3. Cada pedido siguiente trae la cookie; el middleware verifica la firma.
     Sin cookie válida: las páginas redirigen al login y la API responde 401.

Cambiar WEB_CLAVE en el .env invalida todas las sesiones abiertas, porque la
firma se calcula a partir de la clave.

Acceso desde internet (Tailscale Funnel): Funnel le agrega al pedido
X-Forwarded-For (la IP real del visitante, reemplazando cualquier valor que
traiga) y X-Forwarded-Proto: https. Con eso limitamos los intentos por IP real
y marcamos la cookie como Secure (solo viaja cifrada).
"""
from __future__ import annotations

import hashlib
import hmac
import time
from collections import defaultdict

from fastapi import Request
from fastapi.responses import JSONResponse, RedirectResponse

COOKIE = "sesion"
DURACION_S = 30 * 24 * 3600          # 30 días
# Lo que se puede ver sin clave: la página de login, sus estilos y el login en sí.
PUBLICO = {"/login.html", "/estilos.css", "/api/login"}
PUBLICO_PREFIJOS = ("/vendor/fonts/",)  # tipografías de la pantalla de ingreso
MAX_FALLOS = 5                       # intentos fallidos seguidos por IP...
BLOQUEO_S = 60                       # ...antes de hacerla esperar un minuto
MAX_FALLOS_TOTAL = 20                # y si llegan muchos desde IPs distintas, se frena todo
# Cabeceras que le dicen al navegador que sea más estricto con esta página.
CABECERAS_SEGURIDAD = {
    "X-Frame-Options": "DENY",                 # no se puede meter dentro de otra página
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
}


def ip_cliente(request: Request) -> str:
    """IP real: la que pone Funnel en X-Forwarded-For, o la de la conexión."""
    reenviada = request.headers.get("x-forwarded-for")
    if reenviada:
        return reenviada.split(",")[-1].strip()
    return request.client.host if request.client else "?"


def es_https(request: Request) -> bool:
    return request.headers.get("x-forwarded-proto") == "https" or request.url.scheme == "https"


def _llave(clave: str) -> bytes:
    return hashlib.sha256(f"sala-cultivo:{clave}".encode()).digest()


def crear_token(clave: str, ahora: float | None = None) -> str:
    vence = int((ahora or time.time()) + DURACION_S)
    firma = hmac.new(_llave(clave), str(vence).encode(), hashlib.sha256).hexdigest()
    return f"{vence}.{firma}"


def token_valido(clave: str, token: str | None, ahora: float | None = None) -> bool:
    if not token or "." not in token:
        return False
    vence, firma = token.split(".", 1)
    if not vence.isdigit() or int(vence) < (ahora or time.time()):
        return False
    esperada = hmac.new(_llave(clave), vence.encode(), hashlib.sha256).hexdigest()
    return hmac.compare_digest(firma, esperada)  # comparación en tiempo constante


class Acceso:
    """Middleware + lógica de login. Si `clave` está vacía, no pide nada."""

    def __init__(self, clave: str):
        self.clave = clave
        self._fallos: dict[str, list[float]] = defaultdict(list)

    @property
    def activo(self) -> bool:
        return bool(self.clave)

    async def middleware(self, request: Request, call_next):
        ruta = request.url.path
        publica = ruta in PUBLICO or ruta.startswith(PUBLICO_PREFIJOS)
        if not self.activo or publica or token_valido(self.clave, request.cookies.get(COOKIE)):
            respuesta = await call_next(request)
        elif ruta.startswith("/api/"):
            respuesta = JSONResponse({"detail": "Necesitás ingresar la clave"}, status_code=401)
        else:
            respuesta = RedirectResponse("/login.html", status_code=303)
        respuesta.headers.update(CABECERAS_SEGURIDAD)
        return respuesta

    def _recientes(self, clave: str) -> list[float]:
        recientes = [t for t in self._fallos[clave] if time.time() - t < BLOQUEO_S]
        self._fallos[clave] = recientes
        return recientes

    def bloqueada(self, ip: str) -> bool:
        return len(self._recientes(ip)) >= MAX_FALLOS or len(self._recientes("*")) >= MAX_FALLOS_TOTAL

    def verificar(self, ip: str, clave: str) -> bool:
        ok = hmac.compare_digest(clave.encode(), self.clave.encode())
        if ok:
            self._fallos.pop(ip, None)
        else:
            self._fallos[ip].append(time.time())
            self._fallos["*"].append(time.time())  # contador de todas las IPs juntas
        return ok
