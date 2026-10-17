"""Sign-in payloads (contract 1.3.0): User, the {user} answer, register, login and password change.

The request models only carry types. The rules (email format, password policy, display name length) are
checked by app.auth.policy, which answers 422 validation_error with one plain message per field, so the
sign-in forms can show the server's text under the right field.
"""

from __future__ import annotations

from datetime import datetime
from typing import Literal

from app.schemas.common import ApiModel

Role = Literal["reviewer", "admin"]
ROLES: tuple[Role, ...] = ("reviewer", "admin")

EMAIL_MAX_LENGTH = 254
PASSWORD_MIN_LENGTH = 10
PASSWORD_MAX_LENGTH = 128
DISPLAY_NAME_MAX_LENGTH = 80


class UserOut(ApiModel):
    user_id: str
    email: str
    display_name: str | None
    role: Role
    created_at: datetime


class UserAnswer(ApiModel):
    """The answer of register, login and me: `{"user": User}`."""

    user: UserOut


class AuthRegisterRequest(ApiModel):
    email: str
    password: str
    display_name: str | None = None


class AuthLoginRequest(ApiModel):
    email: str
    password: str


class AuthPasswordChange(ApiModel):
    current_password: str
    new_password: str
