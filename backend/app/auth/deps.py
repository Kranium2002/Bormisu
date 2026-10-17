"""The signed-in user for routes: `current_user` (401 not_authenticated without a session) and the actor.

Every /api/v1 route except the health checks, register and login depends on `current_user` (router
dependencies in app.main). With AUTH_ENABLED=false every request acts as LOCAL_USER, a fixed local admin,
and no cookie is needed.

Writes (POST, PUT, PATCH, DELETE) sent by a browser must come from an allowed page: an Origin (or, without
it, a Referer) that is neither in CORS_ORIGINS nor the request's own host answers 403 forbidden. Requests
without either header (scripts, curl, tests) pass; the SameSite=Lax cookie already stays home on
cross-site writes.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Annotated
from urllib.parse import urlsplit

from fastapi import Depends, Request

from app.auth.sessions import COOKIE_NAME, user_for_token
from app.config import get_settings
from app.db.models import User
from app.db.session import get_sessionmaker
from app.errors import ApiError
from app.schemas.auth import Role, UserOut
from app.schemas.common import review_actor

UNSAFE_METHODS = frozenset({"POST", "PUT", "PATCH", "DELETE"})


@dataclass(frozen=True)
class SessionUser:
    """Who sends the request. `token_hash` names their session (None for LOCAL_USER)."""

    user_id: str
    email: str
    display_name: str | None
    role: Role
    created_at: datetime
    token_hash: str | None = None

    @classmethod
    def of(cls, user: User, token_hash: str | None = None) -> SessionUser:
        role: Role = "admin" if user.role == "admin" else "reviewer"
        return cls(
            user_id=user.id,
            email=user.email,
            display_name=user.display_name,
            role=role,
            created_at=user.created_at,
            token_hash=token_hash,
        )

    def out(self) -> UserOut:
        return UserOut(
            user_id=self.user_id,
            email=self.email,
            display_name=self.display_name,
            role=self.role,
            created_at=self.created_at,
        )


# The actor of every request while AUTH_ENABLED=false. Not stored in the database.
LOCAL_USER = SessionUser(
    user_id="usr_00000000000000000000000000",
    email="local@localhost",
    display_name="Local user",
    role="admin",
    created_at=datetime(2026, 1, 1, tzinfo=UTC),
)


def actor_name(user: SessionUser) -> str:
    """The name stored as revision actor, `confirmed_by` and `answered_by`: display name, else email."""
    return review_actor(user.display_name or user.email)


def _origin_of(url: str) -> str | None:
    parts = urlsplit(url.strip())
    if not parts.scheme or not parts.netloc:
        return None
    return f"{parts.scheme}://{parts.netloc}".lower()


def _own_hosts(request: Request) -> set[str]:
    hosts = set()
    for header in ("host", "x-forwarded-host"):
        value = request.headers.get(header)
        if value:
            hosts.add(value.split(",")[0].strip().lower())
    return hosts


def check_origin(request: Request) -> None:
    """403 forbidden for a browser write sent from a page of another site (see the module docstring)."""
    if request.method not in UNSAFE_METHODS:
        return
    sent = request.headers.get("origin")
    if sent is None:
        referer = request.headers.get("referer")
        if not referer:
            return
        sent = referer
    origin = _origin_of(sent)
    if origin is not None:
        allowed = {o.rstrip("/").lower() for o in get_settings().cors_origin_list}
        if origin in allowed or urlsplit(origin).netloc in _own_hosts(request):
            return
    raise ApiError(403, "forbidden", "This request came from a page of another site and was refused.")


def client_address(request: Request) -> str:
    """The client's address for limits: the last X-Forwarded-For hop (added by our proxy), else the peer."""
    forwarded = request.headers.get("x-forwarded-for")
    if forwarded:
        last = forwarded.split(",")[-1].strip()
        if last:
            return last
    return request.client.host if request.client else "unknown"


async def current_user(request: Request) -> SessionUser:
    """The signed-in user; 401 not_authenticated without a valid session cookie."""
    if not get_settings().auth_enabled:
        return LOCAL_USER
    check_origin(request)
    token = request.cookies.get(COOKIE_NAME)
    if token:
        async with get_sessionmaker()() as session:
            found = await user_for_token(session, token)
        if found is not None:
            user, auth_session = found
            return SessionUser.of(user, auth_session.token_hash)
    raise ApiError(401, "not_authenticated", "Sign in to continue.")


CurrentUser = Annotated[SessionUser, Depends(current_user)]
