"""Sign-in routes (contract 1.3.0): register, login, logout, me, password.

register and login are public; logout answers 204 with or without a session (idempotent); me and
password need a session. Writes check the Origin like every other write (app.auth.deps.check_origin).
"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, Request, Response
from fastapi.responses import JSONResponse
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.deps import CurrentUser, SessionUser, check_origin, client_address
from app.auth.limits import limits_of
from app.auth.policy import (
    checked_registration,
    field_error,
    new_password_error,
    normalize_email,
    raise_if_any,
)
from app.auth.service import authenticate, create_user, password_matches, set_password
from app.auth.sessions import (
    COOKIE_NAME,
    clear_session_cookie,
    end_session,
    set_session_cookie,
    start_session,
)
from app.config import get_settings
from app.db.models import User
from app.db.session import get_session
from app.errors import ApiError, error_response
from app.schemas.auth import (
    AuthLoginRequest,
    AuthPasswordChange,
    AuthRegisterRequest,
    UserAnswer,
)

router = APIRouter(prefix="/auth", tags=["auth"])
SessionDep = Annotated[AsyncSession, Depends(get_session)]


def _rate_limited(retry_after: int) -> JSONResponse:
    response = error_response(429, "rate_limited", f"Too many attempts. Try again in {retry_after} seconds.")
    response.headers["Retry-After"] = str(retry_after)
    return response


def _signed_in(user: User, token: str, status_code: int) -> JSONResponse:
    body = UserAnswer(user=SessionUser.of(user).out())
    response = JSONResponse(body.model_dump(mode="json"), status_code=status_code)
    set_session_cookie(response, token)
    return response


@router.post(
    "/register",
    response_model=UserAnswer,
    status_code=201,
    operation_id="register",
    responses={409: {"description": "email_taken"}, 429: {"description": "rate_limited"}},
)
async def register(body: AuthRegisterRequest, request: Request, session: SessionDep) -> Response:
    check_origin(request)
    email, display_name = checked_registration(body.email, body.password, body.display_name)
    limits = limits_of(request.app.state)
    address = client_address(request)
    if (wait := limits.register_ip.retry_after(address)) is not None:
        return _rate_limited(wait)
    limits.register_ip.hit(address)
    closed = get_settings().auth_registration == "closed"
    user = await create_user(
        session, email=email, password=body.password, display_name=display_name, only_first=closed
    )
    token = await start_session(session, user.id)
    await session.commit()
    return _signed_in(user, token, 201)


@router.post(
    "/login",
    response_model=UserAnswer,
    operation_id="login",
    responses={401: {"description": "invalid_credentials"}, 429: {"description": "rate_limited"}},
)
async def login(body: AuthLoginRequest, request: Request, session: SessionDep) -> Response:
    check_origin(request)
    email = normalize_email(body.email)
    errors = []
    if not email:
        errors.append(field_error("email", "Enter your email."))
    if not body.password:
        errors.append(field_error("password", "Enter your password."))
    raise_if_any(errors)
    limits = limits_of(request.app.state)
    address = client_address(request)
    waits = [limits.login_email.retry_after(email), limits.login_ip.retry_after(address)]
    if any(w is not None for w in waits):
        return _rate_limited(max(w for w in waits if w is not None))
    user = await authenticate(session, email, body.password)
    if user is None:
        limits.login_email.hit(email)
        limits.login_ip.hit(address)
        raise ApiError(401, "invalid_credentials", "The email or the password is wrong.")
    limits.login_email.reset(email)
    token = await start_session(session, user.id)
    await session.commit()
    return _signed_in(user, token, 200)


@router.post("/logout", status_code=204, operation_id="logout")
async def logout(request: Request, session: SessionDep) -> Response:
    check_origin(request)
    token = request.cookies.get(COOKIE_NAME)
    if token:
        await end_session(session, token)
        await session.commit()
    response = Response(status_code=204)
    clear_session_cookie(response)
    return response


@router.get("/me", response_model=UserAnswer, operation_id="getMe")
async def me(user: CurrentUser) -> UserAnswer:
    return UserAnswer(user=user.out())


@router.post(
    "/password",
    status_code=204,
    operation_id="changePassword",
    responses={401: {"description": "invalid_credentials or not_authenticated"}},
)
async def change_password(
    body: AuthPasswordChange, request: Request, user: CurrentUser, session: SessionDep
) -> Response:
    if user.token_hash is None:
        raise ApiError(
            403, "forbidden", "Sign-in is turned off on this server; there is no password to change."
        )
    raise_if_any(
        [field_error("new_password", problem)]
        if (problem := new_password_error(body.new_password, user.email))
        else []
    )
    limits = limits_of(request.app.state)
    if (wait := limits.login_email.retry_after(user.email)) is not None:
        return _rate_limited(wait)
    account = await session.get(User, user.user_id)
    if account is None:
        raise ApiError(401, "not_authenticated", "Sign in to continue.")
    if not await password_matches(account, body.current_password):
        limits.login_email.hit(user.email)
        raise ApiError(401, "invalid_credentials", "The current password is wrong.")
    await set_password(session, account, body.new_password, keep_session_hash=user.token_hash)
    await session.commit()
    return Response(status_code=204)
