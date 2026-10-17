# GeoMemory developer commands (GNU make, POSIX sh). `make` or `make help` lists the targets.
# Everything except `eval` runs in Docker Compose; `eval` runs on the host with uv.

COMPOSE ?= docker compose
# The "test" service (profile "test") runs the backend dev image without provider keys.
TEST_RUN = $(COMPOSE) --profile test run --rm --build

# Cost cap of `make eval` in USD; override with `make eval EVAL_MAX_USD=2` or the environment.
EVAL_MAX_USD ?= 1

.DEFAULT_GOAL := help
.PHONY: help up down logs ps migrate seed unseed test contract-test lint eval

help: ## List the targets
	@echo "GeoMemory make targets:"
	@awk 'BEGIN { FS = ":.*## " } /^[a-z][a-z-]*:.*## / { printf "  %-14s %s\n", $$1, $$2 }' $(MAKEFILE_LIST)

up: ## Build and start the stack in the background (http://localhost:8080)
	$(COMPOSE) up --build -d

down: ## Stop the stack (data volumes are kept)
	$(COMPOSE) down

logs: ## Follow the logs of all services
	$(COMPOSE) logs -f --tail=200

ps: ## Show the state of the services
	$(COMPOSE) ps

migrate: ## Apply database migrations (alembic upgrade head)
	$(COMPOSE) run --rm --build migrate

seed: ## Load clearly fictional demo data into the running stack
	$(COMPOSE) exec api python -m app.seed

unseed: ## Remove the fictional demo data again
	$(COMPOSE) exec api python -m app.seed --remove

test: ## Run the backend test suite in Docker (no provider keys, database geomemory_test)
	$(TEST_RUN) test

contract-test: ## Run only the contract tests against contracts/
	$(TEST_RUN) test python -m pytest -q tests/contract

lint: ## ruff check, ruff format --check and mypy in Docker
	$(TEST_RUN) --no-deps test sh -c 'ruff check . && ruff format --check . && mypy'

eval: ## Evaluate the real pipeline on sample files on the host (uses the keys; set EVAL_DATA_DIR, EVAL_EXPECTED)
	@if [ -z "$$EVAL_DATA_DIR" ] || [ -z "$$EVAL_EXPECTED" ]; then \
	  echo "make eval: set EVAL_DATA_DIR and EVAL_EXPECTED (environment or make eval EVAL_DATA_DIR=... EVAL_EXPECTED=...)" >&2; \
	  exit 2; \
	fi
	cd backend && uv run $(if $(wildcard .env),--env-file ../.env) python -m app.eval \
	  --data-dir "$$EVAL_DATA_DIR" --expected "$$EVAL_EXPECTED" --max-usd "$(or $(EVAL_MAX_USD),1)"
