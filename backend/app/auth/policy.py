"""Account rules (contract 1.4.0) as 422 field errors with plain messages the forms show as they are.

- email: trimmed and lower-cased, one "@" with text on both sides, no spaces, at most 254 characters;
- password: 8 to 128 characters, nothing else;
- display_name: trimmed, blank is none, at most 80 characters.
"""

from __future__ import annotations

import re
from typing import Any

from app.errors import ApiError
from app.schemas.auth import (
    DISPLAY_NAME_MAX_LENGTH,
    EMAIL_MAX_LENGTH,
    PASSWORD_MAX_LENGTH,
    PASSWORD_MIN_LENGTH,
)

FieldError = dict[str, Any]

_EMAIL = re.compile(r"[^@\s]+@[^@\s]+")


def field_error(field: str, message: str) -> FieldError:
    return {"loc": ["body", field], "msg": message}


def raise_if_any(errors: list[FieldError]) -> None:
    if errors:
        raise ApiError(422, "validation_error", "The request is not valid.", errors)


def normalize_email(raw: str) -> str:
    return raw.strip().lower()


def email_error(email: str) -> str | None:
    """The problem with an already normalised email, or None."""
    if not email:
        return "Enter your email."
    if len(email) > EMAIL_MAX_LENGTH:
        return f"At most {EMAIL_MAX_LENGTH} characters."
    if not _EMAIL.fullmatch(email):
        return "Enter an email address such as name@example.org."
    return None


def password_error(password: str) -> str | None:
    """The problem with a new password (its length), or None."""
    if not password:
        return "Enter a password."
    if len(password) < PASSWORD_MIN_LENGTH:
        return f"Use at least {PASSWORD_MIN_LENGTH} characters."
    if len(password) > PASSWORD_MAX_LENGTH:
        return f"Use at most {PASSWORD_MAX_LENGTH} characters."
    return None


def normalize_display_name(raw: str | None) -> str | None:
    name = (raw or "").strip()
    return name or None


def display_name_error(name: str | None) -> str | None:
    if name is not None and len(name) > DISPLAY_NAME_MAX_LENGTH:
        return f"At most {DISPLAY_NAME_MAX_LENGTH} characters."
    return None


def checked_registration(
    email_raw: str, password: str, display_name_raw: str | None
) -> tuple[str, str | None]:
    """(email, display_name) as stored; 422 validation_error listing every field that breaks a rule."""
    email = normalize_email(email_raw)
    display_name = normalize_display_name(display_name_raw)
    errors: list[FieldError] = []
    if problem := email_error(email):
        errors.append(field_error("email", problem))
    if problem := password_error(password):
        errors.append(field_error("password", problem))
    if problem := display_name_error(display_name):
        errors.append(field_error("display_name", problem))
    raise_if_any(errors)
    return email, display_name
