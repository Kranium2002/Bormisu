"""Sign-in routes (contract 1.3.0): register, login, logout, me.

register and login are public; logout answers 204 with or without a session (idempotent); me needs a
session. There are no rate limits and no Origin check (minimal sign-in, hackathon scope).
"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, Request, Response
from fastapi.responses import JSONResponse
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.deps import CurrentUser, SessionUser
from app.auth.policy import checked_registration, field_error, normalize_email, raise_if_any
from app.auth.service import authenticate, create_user
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
from app.errors import ApiError
from app.schemas.auth import AuthLoginRequest, AuthRegisterRequest, UserAnswer

router = APIRouter(prefix="/auth", tags=["auth"])
SessionDep = Annotated[AsyncSession, Depends(get_session)]


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
    responses={403: {"description": "forbidden"}, 409: {"description": "email_taken"}},
)
async def register(body: AuthRegisterRequest, session: SessionDep) -> Response:
    email, display_name = checked_registration(body.email, body.password, body.display_name)
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
    responses={401: {"description": "invalid_credentials"}},
)
async def login(body: AuthLoginRequest, session: SessionDep) -> Response:
    email = normalize_email(body.email)
    errors = []
    if not email:
        errors.append(field_error("email", "Enter your email."))
    if not body.password:
        errors.append(field_error("password", "Enter your password."))
    raise_if_any(errors)
    user = await authenticate(session, email, body.password)
    if user is None:
        raise ApiError(401, "invalid_credentials", "The email or the password is wrong.")
    token = await start_session(session, user.id)
    await session.commit()
    return _signed_in(user, token, 200)


@router.post("/logout", status_code=204, operation_id="logout")
async def logout(request: Request, session: SessionDep) -> Response:
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
