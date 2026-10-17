"""Accounts: register, authenticate, reset a password. Used by the routes and the CLI.

The first account becomes admin, later ones reviewer (an advisory lock makes two simultaneous first
registrations safe). Hashing runs in a worker thread so it never blocks the event loop.
"""

from __future__ import annotations

import asyncio

from sqlalchemy import func, select, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.passwords import burn_verify, hash_password, verify_password
from app.auth.sessions import end_sessions
from app.db.models import User
from app.errors import ApiError
from app.ids import new_id
from app.schemas.auth import PASSWORD_MAX_LENGTH, Role

# pg_advisory_xact_lock key for account creation (any fixed number unique to this purpose).
_REGISTER_LOCK = 4_023_001


def email_taken() -> ApiError:
    return ApiError(409, "email_taken", "An account with this email exists already.")


async def user_count(session: AsyncSession) -> int:
    return await session.scalar(select(func.count()).select_from(User)) or 0


async def user_by_email(session: AsyncSession, email: str) -> User | None:
    found: User | None = await session.scalar(select(User).where(User.email == email))
    return found


async def create_user(
    session: AsyncSession,
    *,
    email: str,
    password: str,
    display_name: str | None,
    role: Role | None = None,
    only_first: bool = False,
) -> User:
    """A new account (inputs already checked by app.auth.policy). `role` None: admin if first, else reviewer.

    `only_first`: refuse with 403 forbidden unless this is the first account (closed registration).
    Flushes; the caller commits.
    """
    await session.execute(text("SELECT pg_advisory_xact_lock(:key)"), {"key": _REGISTER_LOCK})
    count = await user_count(session)
    if only_first and count > 0:
        raise ApiError(
            403, "forbidden", "Registration is closed on this server. Ask an admin for an account."
        )
    if await user_by_email(session, email) is not None:
        raise email_taken()
    password_hash = await asyncio.to_thread(hash_password, password)
    user = User(
        id=new_id("usr"),
        email=email,
        password_hash=password_hash,
        display_name=display_name,
        role=role or ("admin" if count == 0 else "reviewer"),
    )
    session.add(user)
    try:
        await session.flush()
    except IntegrityError:
        await session.rollback()
        raise email_taken() from None
    return user


async def authenticate(session: AsyncSession, email: str, password: str) -> User | None:
    """The account when the email and password match, else None (the same answer either way)."""
    user = await user_by_email(session, email) if email else None
    if user is None or len(password) > PASSWORD_MAX_LENGTH:
        await asyncio.to_thread(burn_verify, password[:PASSWORD_MAX_LENGTH])
        return None
    if not await asyncio.to_thread(verify_password, user.password_hash, password):
        return None
    return user


async def set_password(session: AsyncSession, user: User, new_password: str) -> None:
    """Store a new password (command-line reset) and end every session of the user."""
    user.password_hash = await asyncio.to_thread(hash_password, new_password)
    await end_sessions(session, user.id)
    await session.flush()
