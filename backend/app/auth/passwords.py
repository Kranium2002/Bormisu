"""Password hashing: argon2id with the argon2-cffi defaults."""

from __future__ import annotations

from functools import cache

from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerificationError

_HASHER = PasswordHasher()


def hash_password(password: str) -> str:
    """An argon2id hash with a random salt (CPU-bound: call it in a worker thread from async code)."""
    return _HASHER.hash(password)


def verify_password(password_hash: str, password: str) -> bool:
    """True when `password` matches; a malformed stored hash never matches."""
    try:
        return _HASHER.verify(password_hash, password)
    except (VerificationError, InvalidHashError):
        return False


@cache
def _dummy_hash() -> str:
    return _HASHER.hash("not-a-password-of-any-account")


def burn_verify(password: str) -> None:
    """Spend the time of one verification, so an unknown email answers like a wrong password."""
    verify_password(_dummy_hash(), password)
