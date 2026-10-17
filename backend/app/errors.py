"""Contract errors: every non-2xx JSON response is {"detail", "code", "errors"?} without internals."""

from __future__ import annotations

import logging
import uuid
from typing import Any

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException
from starlette.types import ASGIApp, Message, Receive, Scope, Send

logger = logging.getLogger("geomemory.errors")


class ApiError(Exception):
    """Raise from routes and services; rendered as the contract's Error object."""

    def __init__(
        self, status_code: int, code: str, detail: str, errors: list[dict[str, Any]] | None = None
    ) -> None:
        super().__init__(detail)
        self.status_code = status_code
        self.code = code
        self.detail = detail
        self.errors = errors


def error_body(code: str, detail: str, errors: list[dict[str, Any]] | None = None) -> dict[str, Any]:
    body: dict[str, Any] = {"detail": detail, "code": code}
    if errors is not None:
        body["errors"] = errors
    return body


def error_response(
    status_code: int, code: str, detail: str, errors: list[dict[str, Any]] | None = None
) -> JSONResponse:
    return JSONResponse(error_body(code, detail, errors), status_code=status_code)


def not_found(code: str, what: str) -> ApiError:
    return ApiError(404, code, f"{what} not found.")


def _clean_loc(loc: Any) -> list[str | int]:
    return [part if isinstance(part, int) else str(part) for part in (loc or [])]


async def _api_error_handler(_: Request, exc: Exception) -> JSONResponse:
    assert isinstance(exc, ApiError)
    return error_response(exc.status_code, exc.code, exc.detail, exc.errors)


async def _validation_handler(_: Request, exc: Exception) -> JSONResponse:
    assert isinstance(exc, RequestValidationError)
    errors = [{"loc": _clean_loc(e.get("loc")), "msg": str(e.get("msg", "invalid"))} for e in exc.errors()]
    return error_response(422, "validation_error", "The request is not valid.", errors)


async def _http_handler(_: Request, exc: Exception) -> JSONResponse:
    assert isinstance(exc, StarletteHTTPException)
    if exc.status_code == 404:
        return error_response(404, "route_not_found", "No such route.")
    if exc.status_code == 405:
        return error_response(405, "route_not_found", "Method not allowed on this route.")
    code = "rate_limited" if exc.status_code == 429 else "internal_error"
    detail = exc.detail if isinstance(exc.detail, str) and exc.status_code < 500 else "Request failed."
    return error_response(exc.status_code, code, detail)


class CatchAllMiddleware:
    """Turns unhandled exceptions into a 500 internal_error with a correlation id (logged, not leaked)."""

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        started = False

        async def send_wrapper(message: Message) -> None:
            nonlocal started
            if message["type"] == "http.response.start":
                started = True
            await send(message)

        try:
            await self.app(scope, receive, send_wrapper)
        except Exception:
            ref = uuid.uuid4().hex[:12]
            logger.exception("unhandled error ref=%s path=%s", ref, scope.get("path"))
            if started:
                raise
            response = error_response(500, "internal_error", f"Internal error (reference {ref}).")
            await response(scope, receive, send)


def install_error_handlers(app: FastAPI) -> None:
    app.add_exception_handler(ApiError, _api_error_handler)
    app.add_exception_handler(RequestValidationError, _validation_handler)
    app.add_exception_handler(StarletteHTTPException, _http_handler)
