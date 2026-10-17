# syntax=docker/dockerfile:1.7
# GeoMemory backend image (api, worker, migrate; "dev" adds tests and linters).
# Build context is the REPOSITORY ROOT so the image can include assets/ and contracts/:
#   docker build -f backend/Dockerfile --target runtime .
# The ignore list is backend/Dockerfile.dockerignore (BuildKit reads it next to this file).
# Only exec-form commands: no shell scripts, so CRLF checkouts on Windows cannot break the image.

# ---------------------------------------------------------------------------------------------
# base: Python + uv + locked third-party dependencies (no project code, cached across code edits)
# ---------------------------------------------------------------------------------------------
FROM python:3.12.15-slim-trixie AS base

COPY --from=ghcr.io/astral-sh/uv:0.13.1 /uv /uvx /bin/

ENV UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PROJECT_ENVIRONMENT=/app/.venv \
    UV_PYTHON_DOWNLOADS=never \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1

WORKDIR /app

COPY backend/pyproject.toml backend/uv.lock ./
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --frozen --no-dev --no-install-project

# ---------------------------------------------------------------------------------------------
# runtime: the production image (default target, see the last stage)
# ---------------------------------------------------------------------------------------------
FROM base AS runtime

RUN groupadd --system --gid 10001 app \
    && useradd --system --uid 10001 --gid app --home-dir /app --no-create-home \
       --shell /usr/sbin/nologin app \
    && mkdir -p /data/storage \
    && chown -R app:app /data

# Static inputs first (rarely change), application code last.
# backend/app/config.py finds assets/ and contracts/ by walking up from /app.
COPY assets/din4023_patterns/din_codes.json /app/assets/din4023_patterns/din_codes.json
COPY contracts/openapi.yaml /app/contracts/openapi.yaml
COPY backend/alembic.ini /app/alembic.ini
COPY backend/migrations /app/migrations
COPY backend/data /app/data
COPY backend/app /app/app

ENV PATH="/app/.venv/bin:$PATH" \
    STORAGE_DIR=/data/storage

USER app

EXPOSE 8000

# python:slim has no curl. Exit code 0 only when /api/health answers 200.
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=5 \
    CMD ["python", "-c", "import sys, urllib.request; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8000/api/health', timeout=4).status == 200 else 1)"]

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--proxy-headers"]

# ---------------------------------------------------------------------------------------------
# dev: runtime + dev dependency group + tests (make test / lint / contract-test)
# ---------------------------------------------------------------------------------------------
FROM runtime AS dev

USER root

RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --frozen --no-install-project

COPY backend/pyproject.toml /app/pyproject.toml
COPY backend/tests /app/tests
# All of contracts/: the contract tests also read contracts/examples/.
COPY contracts /app/contracts

# pytest, Hypothesis, ruff and mypy write their caches into /app.
RUN chown app:app /app

USER app

# ---------------------------------------------------------------------------------------------
# Default target for a plain `docker build`: the runtime image (compose names its targets).
# ---------------------------------------------------------------------------------------------
FROM runtime AS final
