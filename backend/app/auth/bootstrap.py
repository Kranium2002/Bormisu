"""The startup account: AUTH_BOOTSTRAP_EMAIL and AUTH_BOOTSTRAP_PASSWORD (Settings.bootstrap_account; the
HACKATHON_EMAIL / HACKATHON_USERNAME / HACKATHON_PASSWORD names work too).

At api startup the account is created as admin, or brought up to date: a different password is stored
(hashed; that ends the account's sessions, like a reset) and the role becomes admin. Run again with the same
values it changes nothing. The password is never logged.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Literal

from app.auth.passwords import verify_password
from app.auth.policy import email_error, normalize_email, password_error
from app.auth.service import create_user, set_password, user_by_email
from app.config import Settings
from app.db.session import get_sessionmaker
from app.errors import ApiError

logger = logging.getLogger("geomemory.auth")

Outcome = Literal["created", "updated", "unchanged"]


async def ensure_account(email_raw: str, password: str) -> Outcome:
    """Create the admin account `email`, or set its password and role (idempotent). ValueError when the
    email or the password breaks the account rules (app.auth.policy)."""
    email = normalize_email(email_raw)
    if (problem := email_error(email)) is not None:
        raise ValueError(f"email: {problem}")
    if (problem := password_error(password)) is not None:
        raise ValueError(f"password: {problem}")
    for _ in range(2):
        async with get_sessionmaker()() as session:
            user = await user_by_email(session, email)
            if user is None:
                try:
                    await create_user(
                        session, email=email, password=password, display_name=None, role="admin"
                    )
                except ApiError as exc:
                    if exc.code != "email_taken":
                        raise
                    continue  # another api process created it a moment ago: update that one instead
                await session.commit()
                return "created"
            changed = False
            if not await asyncio.to_thread(verify_password, user.password_hash, password):
                await set_password(session, user, password)
                changed = True
            if user.role != "admin":
                user.role = "admin"
                changed = True
            await session.commit()
            return "updated" if changed else "unchanged"
    raise RuntimeError("the startup account could not be created")


async def provision(settings: Settings) -> Outcome | None:
    """Apply the configured startup account; None when none is configured or it failed (the api still
    starts; the reason is logged without the password)."""
    account = settings.bootstrap_account
    if account is None:
        return None
    email, password = account
    try:
        outcome = await ensure_account(email, password.get_secret_value())
    except ValueError as exc:
        logger.warning("startup account %s not provisioned: %s", email, exc)
        return None
    except Exception as exc:  # e.g. the database is not migrated yet; never let it stop the api
        logger.warning("startup account %s not provisioned (%s)", email, type(exc).__name__)
        return None
    logger.info("startup account %s %s", normalize_email(email), outcome)
    return outcome
