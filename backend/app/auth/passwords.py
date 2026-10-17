"""Password hashing (argon2id, argon2-cffi defaults) and the list of refused common passwords."""

from __future__ import annotations

from functools import cache

from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerificationError

from app.config import get_settings

COMMON_PASSWORDS_FILE = "common_passwords.txt"

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


def needs_rehash(password_hash: str) -> bool:
    """True when the hash was made with weaker parameters than the current ones."""
    try:
        return _HASHER.check_needs_rehash(password_hash)
    except InvalidHashError:
        return True


@cache
def _dummy_hash() -> str:
    return _HASHER.hash("not-a-password-of-any-account")


def burn_verify(password: str) -> None:
    """Spend the time of one verification, so an unknown email answers as slowly as a wrong password."""
    verify_password(_dummy_hash(), password)


@cache
def common_passwords() -> frozenset[str]:
    """The refused passwords, lower-cased (data/common_passwords.txt; `#` starts a comment line)."""
    path = get_settings().data_dir / COMMON_PASSWORDS_FILE
    entries = set()
    for line in path.read_text(encoding="utf-8").splitlines():
        entry = line.strip()
        if entry and not entry.startswith("#"):
            entries.add(entry.lower())
    return frozenset(entries)


def is_common(password: str) -> bool:
    return password.strip().lower() in common_passwords()
