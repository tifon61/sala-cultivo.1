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
MAX_FALLOS = 5                       # intentos fallidos seguidos por IP...
BLOQUEO_S = 60                       # ...antes de hacerla esperar un minuto


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
        if not self.activo or ruta in PUBLICO or token_valido(self.clave, request.cookies.get(COOKIE)):
            return await call_next(request)
        if ruta.startswith("/api/"):
            return JSONResponse({"detail": "Necesitás ingresar la clave"}, status_code=401)
        return RedirectResponse("/login.html", status_code=303)

    def bloqueada(self, ip: str) -> bool:
        recientes = [t for t in self._fallos[ip] if time.time() - t < BLOQUEO_S]
        self._fallos[ip] = recientes
        return len(recientes) >= MAX_FALLOS

    def verificar(self, ip: str, clave: str) -> bool:
        ok = hmac.compare_digest(clave.encode(), self.clave.encode())
        if ok:
            self._fallos.pop(ip, None)
        else:
            self._fallos[ip].append(time.time())
        return ok
