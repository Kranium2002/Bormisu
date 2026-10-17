"""Settings from the environment. Secrets are read here only and never logged."""

from __future__ import annotations

from functools import lru_cache
from pathlib import Path
from typing import Literal

from pydantic import AliasChoices, Field, SecretStr, ValidationInfo, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

BACKEND_DIR = Path(__file__).resolve().parent.parent


def _find_upwards(relative: str) -> Path:
    """Locate a repository file from the backend package (works in the repo and in the image)."""
    here = BACKEND_DIR
    for base in (here, *here.parents):
        candidate = base / relative
        if candidate.exists():
            return candidate
    return here / relative


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=None,
        extra="ignore",
        case_sensitive=False,
        populate_by_name=True,
    )

    # Core
    database_url: str = "postgresql+asyncpg://geomemory:geomemory@db:5432/geomemory"
    storage_dir: Path = Path("/data/storage")
    max_upload_mb: int = 200
    accepted_extensions: str = ".pdf,.png,.jpg,.jpeg,.webp,.tif,.tiff,.docx,.xlsx,.csv"
    cors_origins: str = "http://localhost:8080,http://localhost:5173"
    log_level: str = "INFO"

    # Sign-in (contract 1.3.0). AUTH_ENABLED=false is a local escape hatch: every request then acts as
    # one fixed local admin and no route needs a session. COOKIE_SECURE=true only behind HTTPS.
    auth_enabled: bool = True
    cookie_secure: bool = False
    # "open": anyone may create an account (the first one becomes admin). "closed": only the first
    # account can be registered in the browser; later ones come from `python -m app.users create`.
    auth_registration: Literal["open", "closed"] = "open"

    # Providers (secrets)
    openrouter_api_key: SecretStr | None = Field(
        default=None, validation_alias=AliasChoices("OPENROUTER_API_KEY", "OPEN_ROUTER_KEY")
    )
    mistral_api_key: SecretStr | None = None
    openai_api_key: SecretStr | None = None

    # Providers (settings)
    openrouter_base_url: str = "https://openrouter.ai/api/v1"
    openrouter_app_title: str = "GeoMemory"
    openrouter_app_url: str = "http://localhost:8080"
    openrouter_data_collection: Literal["allow", "deny"] = "deny"
    mistral_base_url: str = "https://api.mistral.ai/v1"
    classifier_model: str = "mistralai/mistral-small-2603"
    extractor_model: str = "mistralai/mistral-large-4-0"
    mistral_ocr_model: str = "mistral-ocr-latest"
    ocr_fallback: Literal["openrouter", "none"] = "openrouter"
    # Which OCR route the pipeline uses: mistral (direct API, needs MISTRAL_API_KEY; boxes and confidence),
    # openrouter (Mistral OCR via the OpenRouter file-parser plugin, text only), or auto (mistral when its key
    # is set, else openrouter; a Mistral 401/403 falls back to openrouter when OpenRouter is configured).
    ocr_provider: Literal["auto", "openrouter", "mistral"] = "auto"
    # Recorded and budgeted per page for the OpenRouter route (parser price: 2 USD per 1,000 pages).
    openrouter_ocr_usd_per_page: float = 0.002
    chat_model: str = "gpt-6.1-sol"
    embedding_model: str = "qwen/qwen3-embedding-8b"
    # Reasoning ("thinking") for the classifier and extractor on OpenRouter. Copying printed values needs
    # none, and reasoning tokens count against max_tokens: with it on, answers can end before the JSON.
    llm_reasoning: Literal["off", "low", "medium", "high"] = "off"

    # Pipeline thresholds
    important_page_roles: str = (
        "log_sheet,log_continuation,summary_table,coordinate_table,lab_results,legend_or_key"
    )
    classifier_min_confidence: float = 0.6
    ocr_low_confidence: float = 0.75
    clean_confidence: float = 0.9
    ocr_max_pages_per_request: int = 8
    ocr_max_request_mb: int = 20
    extract_max_input_tokens: int = 200_000
    concurrency_classify: int = 8
    concurrency_ocr: int = 4
    concurrency_extract: int = 4

    # Geocoding and office conversion
    geocoder: Literal["nominatim", "none"] = "nominatim"
    nominatim_url: str = "https://nominatim.openstreetmap.org"
    geocoder_user_agent: str = "GeoMemory/1.0 (contact: set-me)"
    gotenberg_url: str = "http://gotenberg:3000"

    # Cost logging and evaluation
    price_table: Path = Field(default_factory=lambda: BACKEND_DIR / "data" / "prices.yaml")
    eval_data_dir: Path | None = None
    eval_expected: Path | None = None
    eval_max_usd: float = 1.0
    # Hard cap on the summed cost of all paid provider calls recorded in provider_calls (None = no cap).
    provider_budget_usd: float | None = None

    # Static inputs shipped with the repository (copied into the image)
    din_codes_path: Path = Field(
        default_factory=lambda: _find_upwards("assets/din4023_patterns/din_codes.json")
    )
    contract_path: Path = Field(default_factory=lambda: _find_upwards("contracts/openapi.yaml"))
    data_dir: Path = Field(default_factory=lambda: BACKEND_DIR / "data")

    @field_validator("openrouter_api_key", "mistral_api_key", "openai_api_key", mode="before")
    @classmethod
    def _blank_is_none(cls, value: object) -> object:
        if isinstance(value, str) and not value.strip():
            return None
        return value

    @field_validator("eval_data_dir", "eval_expected", "provider_budget_usd", mode="before")
    @classmethod
    def _blank_path_is_none(cls, value: object) -> object:
        if isinstance(value, str) and not value.strip():
            return None
        return value

    @field_validator("auth_enabled", "cookie_secure", mode="before")
    @classmethod
    def _blank_flag_is_default(cls, value: object, info: ValidationInfo) -> object:
        if isinstance(value, str) and not value.strip():
            return info.field_name == "auth_enabled"
        return value

    @field_validator("auth_registration", mode="before")
    @classmethod
    def _blank_registration_is_open(cls, value: object) -> object:
        if isinstance(value, str):
            return value.strip().lower() or "open"
        return value

    # Derived values -------------------------------------------------------------------------

    @property
    def extensions(self) -> list[str]:
        items = [e.strip().lower() for e in self.accepted_extensions.split(",") if e.strip()]
        return [e if e.startswith(".") else f".{e}" for e in items]

    @property
    def cors_origin_list(self) -> list[str]:
        return [o.strip() for o in self.cors_origins.split(",") if o.strip() and o.strip() != "*"]

    @property
    def important_roles(self) -> set[str]:
        return {r.strip() for r in self.important_page_roles.split(",") if r.strip()}

    @property
    def max_upload_bytes(self) -> int:
        return self.max_upload_mb * 1024 * 1024

    @property
    def sync_database_url(self) -> str:
        """libpq URL for psycopg (Procrastinate) derived from the SQLAlchemy URL."""
        url = self.database_url
        for prefix in ("postgresql+asyncpg://", "postgresql+psycopg://", "postgres://"):
            if url.startswith(prefix):
                return "postgresql://" + url[len(prefix) :]
        return url

    @property
    def asyncpg_dsn(self) -> str:
        """Plain DSN for a raw asyncpg connection (SSE LISTEN)."""
        return self.sync_database_url

    @property
    def ocr_configured(self) -> bool:
        return self.ocr_route is not None

    @property
    def ocr_route(self) -> Literal["mistral", "openrouter"] | None:
        """The OCR route OCR_PROVIDER selects with the keys at hand (None: no OCR provider)."""
        has_mistral = self.mistral_api_key is not None
        has_openrouter = self.openrouter_api_key is not None
        if self.ocr_provider == "mistral":
            return "mistral" if has_mistral else None
        if self.ocr_provider == "openrouter":
            return "openrouter" if has_openrouter else None
        if has_mistral:
            return "mistral"
        return "openrouter" if has_openrouter and self.ocr_fallback == "openrouter" else None

    @property
    def classifier_configured(self) -> bool:
        return self.openrouter_api_key is not None

    @property
    def extractor_configured(self) -> bool:
        return self.openrouter_api_key is not None

    @property
    def chat_configured(self) -> bool:
        return self.openai_api_key is not None

    @property
    def geocoder_configured(self) -> bool:
        return self.geocoder != "none"

    @property
    def mode(self) -> Literal["live", "demo"]:
        return "live" if (self.ocr_configured and self.extractor_configured) else "demo"


@lru_cache
def get_settings() -> Settings:
    return Settings()
