"""Fictional accounts for API tests (contract 1.3.0). The `client` fixture signs in as REVIEWER."""

from __future__ import annotations

from dataclasses import dataclass

import httpx

REGISTER = "/api/v1/auth/register"
LOGIN = "/api/v1/auth/login"
LOGOUT = "/api/v1/auth/logout"
ME = "/api/v1/auth/me"


@dataclass(frozen=True)
class Account:
    email: str
    password: str
    display_name: str | None

    @property
    def actor(self) -> str:
        """The name the server records for this account's changes (display name, else email)."""
        return self.display_name or self.email


REVIEWER = Account("reviewer@example.test", "fictional-pass-phrase-1", "Fictional Reviewer")
SECOND = Account("second.reviewer@example.test", "another-fictional-phrase", None)


async def register(client: httpx.AsyncClient, account: Account = REVIEWER) -> dict[str, object]:
    """Create the account and keep its session cookie on `client`; returns the User."""
    body: dict[str, object] = {"email": account.email, "password": account.password}
    if account.display_name is not None:
        body["display_name"] = account.display_name
    response = await client.post(REGISTER, json=body)
    assert response.status_code == 201, response.text
    user: dict[str, object] = response.json()["user"]
    return user


async def login(client: httpx.AsyncClient, account: Account = REVIEWER) -> httpx.Response:
    return await client.post(LOGIN, json={"email": account.email, "password": account.password})
