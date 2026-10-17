"""Cookie sessions: a random 256-bit token in the `gm_session` cookie, its SHA-256 in `sessions`.

A session lasts until sign-out (or a password change or reset, which end the user's other sessions).
The cookie is HttpOnly, SameSite=Lax, Path=/, and Secure only with COOKIE_SECURE=true (HTTPS).
"""

from __future__ import annotations

import hashlib
import secrets
from datetime import UTC, datetime, timedelta

from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession
from starlette.responses import Response

from app.config import get_settings
from app.db.models import AuthSession, User

COOKIE_NAME = "gm_session"
# Browsers cap cookie lifetimes at about 400 days; the session itself has no expiry.
COOKIE_MAX_AGE_S = 400 * 24 * 3600
# last_seen_at is written at most this often per session, not on every request.
TOUCH_INTERVAL = timedelta(minutes=5)


def new_token() -> str:
    return secrets.token_urlsafe(32)


def token_hash(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def set_session_cookie(response: Response, token: str) -> None:
    response.set_cookie(
        COOKIE_NAME,
        token,
        max_age=COOKIE_MAX_AGE_S,
        path="/",
        httponly=True,
        samesite="lax",
        secure=get_settings().cookie_secure,
    )


def clear_session_cookie(response: Response) -> None:
    response.delete_cookie(
        COOKIE_NAME, path="/", httponly=True, samesite="lax", secure=get_settings().cookie_secure
    )


async def start_session(session: AsyncSession, user_id: str) -> str:
    """A new session for the user; returns the token for the cookie (only its hash is stored)."""
    token = new_token()
    session.add(AuthSession(token_hash=token_hash(token), user_id=user_id))
    await session.flush()
    return token


async def end_session(session: AsyncSession, token: str) -> None:
    await session.execute(delete(AuthSession).where(AuthSession.token_hash == token_hash(token)))


async def end_sessions(session: AsyncSession, user_id: str, *, keep_hash: str | None = None) -> None:
    """End every session of the user, except the one with `keep_hash` when given."""
    query = delete(AuthSession).where(AuthSession.user_id == user_id)
    if keep_hash is not None:
        query = query.where(AuthSession.token_hash != keep_hash)
    await session.execute(query)


async def user_for_token(session: AsyncSession, token: str) -> tuple[User, AuthSession] | None:
    """The signed-in user and their session row for a cookie token, or None. Commits a touch now and then."""
    if not token or len(token) > 200:
        return None
    row = (
        await session.execute(
            select(User, AuthSession)
            .join(AuthSession, AuthSession.user_id == User.id)
            .where(AuthSession.token_hash == token_hash(token))
        )
    ).first()
    if row is None:
        return None
    user, auth_session = row
    now = datetime.now(UTC)
    if auth_session.last_seen_at is None or now - auth_session.last_seen_at > TOUCH_INTERVAL:
        auth_session.last_seen_at = now
        await session.commit()
    return user, auth_session
