"""Accounts from the command line (there is no email, so this is also the password reset).

    python -m app.users create --email EMAIL [--name NAME] [--role reviewer|admin] [--password PASSWORD]
    python -m app.users reset-password --email EMAIL [--password PASSWORD]
    python -m app.users set-role --email EMAIL --role reviewer|admin
    python -m app.users list

In docker compose: `docker compose exec api python -m app.users ...`. Without --password the password is
asked for twice (not echoed). The rules are the same as in the browser (app.auth.policy). A new account
without --role becomes admin when it is the first one, else reviewer. A password reset ends every session
of that user.
"""

from __future__ import annotations

import argparse
import asyncio
import getpass
import sys
from collections.abc import Sequence

from sqlalchemy import select

from app.auth.policy import (
    checked_registration,
    email_error,
    new_password_error,
    normalize_email,
)
from app.auth.service import create_user, set_password, user_by_email
from app.auth.sessions import end_sessions
from app.db.models import User
from app.db.session import dispose_engine, get_sessionmaker
from app.errors import ApiError
from app.schemas.auth import ROLES, Role


class UsageError(Exception):
    """A problem the person at the terminal can fix (printed without a traceback)."""


def _messages(error: ApiError) -> str:
    if error.errors:
        return "; ".join(f"{e['loc'][-1]}: {e['msg']}" for e in error.errors)
    return error.detail


def _ask_password(email: str) -> str:
    first = getpass.getpass("New password: ")
    if (problem := new_password_error(first, email)) is not None:
        raise UsageError(f"password: {problem}")
    if getpass.getpass("Repeat the password: ") != first:
        raise UsageError("The passwords do not match.")
    return first


async def create(email: str, password: str | None, name: str | None, role: Role | None) -> str:
    email = normalize_email(email)
    if (problem := email_error(email)) is not None:
        raise UsageError(f"email: {problem}")
    password = password if password is not None else _ask_password(email)
    try:
        email, display_name = checked_registration(email, password, name)
    except ApiError as exc:
        raise UsageError(_messages(exc)) from None
    async with get_sessionmaker()() as session:
        try:
            user = await create_user(
                session, email=email, password=password, display_name=display_name, role=role
            )
        except ApiError as exc:
            raise UsageError(exc.detail) from None
        await session.commit()
        return f"Created {user.role} {user.email} ({user.id})."


async def _existing(email: str) -> tuple[str, User]:
    email = normalize_email(email)
    async with get_sessionmaker()() as session:
        user = await user_by_email(session, email)
    if user is None:
        raise UsageError(f"No account with the email {email}.")
    return email, user


async def reset_password(email: str, password: str | None) -> str:
    email, _ = await _existing(email)
    password = password if password is not None else _ask_password(email)
    if (problem := new_password_error(password, email)) is not None:
        raise UsageError(f"password: {problem}")
    async with get_sessionmaker()() as session:
        user = await user_by_email(session, email)
        if user is None:
            raise UsageError(f"No account with the email {email}.")
        await set_password(session, user, password)
        await session.commit()
    return f"New password set for {email}; every session of this account has ended."


async def set_role(email: str, role: Role) -> str:
    email, _ = await _existing(email)
    async with get_sessionmaker()() as session:
        user = await user_by_email(session, email)
        if user is None:
            raise UsageError(f"No account with the email {email}.")
        user.role = role
        await session.commit()
    return f"{email} is now {role}."


async def sign_out_everywhere(email: str) -> str:
    email, user = await _existing(email)
    async with get_sessionmaker()() as session:
        await end_sessions(session, user.id)
        await session.commit()
    return f"Every session of {email} has ended."


async def list_users() -> str:
    async with get_sessionmaker()() as session:
        users = (await session.scalars(select(User).order_by(User.created_at, User.email))).all()
    if not users:
        return "No accounts yet. The first account registered (in the browser or here) becomes admin."
    width = max(len(u.email) for u in users)
    return "\n".join(f"{u.email:<{width}}  {u.role:<8}  {u.display_name or ''}".rstrip() for u in users)


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="python -m app.users", description="Manage sign-in accounts.")
    commands = parser.add_subparsers(dest="command", required=True)
    add = commands.add_parser("create", help="create an account")
    add.add_argument("--email", required=True)
    add.add_argument("--name", help="display name (shown as the actor of reviews)")
    add.add_argument("--role", choices=ROLES, help="default: admin for the first account, else reviewer")
    add.add_argument("--password", help="asked for when left out (recommended: keeps it out of history)")
    reset = commands.add_parser("reset-password", help="set a new password and end the user's sessions")
    reset.add_argument("--email", required=True)
    reset.add_argument("--password", help="asked for when left out")
    role = commands.add_parser("set-role", help="make an account reviewer or admin")
    role.add_argument("--email", required=True)
    role.add_argument("--role", choices=ROLES, required=True)
    out = commands.add_parser("sign-out", help="end every session of an account")
    out.add_argument("--email", required=True)
    commands.add_parser("list", help="list the accounts")
    return parser


async def _run(args: argparse.Namespace) -> str:
    try:
        if args.command == "create":
            return await create(args.email, args.password, args.name, args.role)
        if args.command == "reset-password":
            return await reset_password(args.email, args.password)
        if args.command == "set-role":
            return await set_role(args.email, args.role)
        if args.command == "sign-out":
            return await sign_out_everywhere(args.email)
        return await list_users()
    finally:
        await dispose_engine()


def main(argv: Sequence[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    try:
        print(asyncio.run(_run(args)))
    except UsageError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
