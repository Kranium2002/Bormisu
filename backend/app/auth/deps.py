"""The signed-in user for routes: `current_user` (401 not_authenticated without a session) and the actor.

Every /api/v1 route except the health checks, register and login depends on `current_user` (router
dependencies in app.main). With AUTH_ENABLED=false every request acts as LOCAL_USER, a fixed local admin,
and no cookie is needed. There is no Origin or Referer check: writes behind the web proxy work whatever
those headers say (the SameSite=Lax cookie already stays home on cross-site writes).
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Annotated

from fastapi import Depends, Request

from app.auth.sessions import COOKIE_NAME, user_for_token
from app.config import get_settings
from app.db.models import User
from app.db.session import get_sessionmaker
from app.errors import ApiError
from app.schemas.auth import Role, UserOut
from app.schemas.common import review_actor


@dataclass(frozen=True)
class SessionUser:
    """Who sends the request."""

    user_id: str
    email: str
    display_name: str | None
    role: Role
    created_at: datetime

    @classmethod
    def of(cls, user: User) -> SessionUser:
        role: Role = "admin" if user.role == "admin" else "reviewer"
        return cls(
            user_id=user.id,
            email=user.email,
            display_name=user.display_name,
            role=role,
            created_at=user.created_at,
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


async def current_user(request: Request) -> SessionUser:
    """The signed-in user; 401 not_authenticated without a valid session cookie."""
    if not get_settings().auth_enabled:
        return LOCAL_USER
    token = request.cookies.get(COOKIE_NAME)
    if token:
        async with get_sessionmaker()() as session:
            found = await user_for_token(session, token)
        if found is not None:
            user, _ = found
            return SessionUser.of(user)
    raise ApiError(401, "not_authenticated", "Sign in to continue.")


CurrentUser = Annotated[SessionUser, Depends(current_user)]
