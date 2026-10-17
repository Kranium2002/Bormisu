"""Settings from the environment. Secrets are read here only and never logged."""

from __future__ import annotations

from functools import lru_cache
from pathlib import Path
from typing import Literal

from pydantic import AliasChoices, Field, SecretStr, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

BACKEND_DIR = Path(__file__).resolve().parent.parent

LlmRoute = Literal["openrouter", "openai"]
OcrRoute = Literal["mistral", "openrouter", "openai"]
ModelRole = Literal["classifier", "extractor"]
OPENAI_BASE_URL = "https://api.openai.com/v1"


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
    # The variable the openai SDK (chat) reads; structured calls and OCR with an OpenAI key use it too.
    openai_base_url: str = OPENAI_BASE_URL
    # Which provider runs the classifier, extractor, second reads and sheet mapping: openrouter, openai, or
    # auto (openrouter when its key is set, else openai; a 401/403 on one moves to the other when that one
    # is configured, remembered per process).
    llm_provider: Literal["auto", "openrouter", "openai"] = "auto"
    # OpenRouter model ids
    classifier_model: str = "mistralai/mistral-small-2603"
    extractor_model: str = "mistralai/mistral-large-4-0"
    # OpenAI model ids (unset or blank: CHAT_MODEL)
    openai_classifier_model: str | None = None
    openai_extractor_model: str | None = None
    openai_ocr_model: str | None = None
    mistral_ocr_model: str = "mistral-ocr-latest"
    ocr_fallback: Literal["openrouter", "none"] = "openrouter"
    # Which OCR route the pipeline uses: mistral (direct API, needs MISTRAL_API_KEY; boxes and confidence),
    # openrouter (Mistral OCR via the OpenRouter file-parser plugin, text only), openai (a vision model
    # transcribes the page render, text only), or auto: mistral -> openrouter -> openai, the first whose key
    # is set; a 401/403 moves on to the next configured route (remembered per process). With
    # OCR_FALLBACK=none, auto uses mistral only.
    ocr_provider: Literal["auto", "openrouter", "mistral", "openai"] = "auto"
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
    # Rate limits (429): a provider call waits (honouring Retry-After, else backing off) until this many
    # seconds of waiting are used. OCR pages still refused then are tried again later in the same job, after
    # a cooldown, up to OCR_RATE_LIMIT_ROUNDS more times; only then is a page left unread (retry reads it).
    rate_limit_wait_s: float = 150.0
    ocr_rate_limit_rounds: int = 2
    ocr_rate_limit_cooldown_s: float = 30.0
    # OCR requests in flight at once on the OpenRouter route, per worker process.
    ocr_openrouter_concurrency: int = 1

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

    @field_validator(
        "eval_data_dir",
        "eval_expected",
        "provider_budget_usd",
        "openai_classifier_model",
        "openai_extractor_model",
        "openai_ocr_model",
        mode="before",
    )
    @classmethod
    def _blank_path_is_none(cls, value: object) -> object:
        if isinstance(value, str) and not value.strip():
            return None
        return value

    @field_validator("openai_base_url", mode="before")
    @classmethod
    def _blank_is_openai(cls, value: object) -> object:
        if value is None or (isinstance(value, str) and not value.strip()):
            return OPENAI_BASE_URL
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
    def ocr_routes(self) -> list[OcrRoute]:
        """The OCR routes OCR_PROVIDER allows with the keys at hand, in the order they are tried."""
        keys: dict[OcrRoute, SecretStr | None] = {
            "mistral": self.mistral_api_key,
            "openrouter": self.openrouter_api_key,
            "openai": self.openai_api_key,
        }
        if self.ocr_provider != "auto":
            return [self.ocr_provider] if keys[self.ocr_provider] is not None else []
        order: tuple[OcrRoute, ...] = (
            ("mistral", "openrouter", "openai") if self.ocr_fallback == "openrouter" else ("mistral",)
        )
        return [route for route in order if keys[route] is not None]

    @property
    def ocr_route(self) -> OcrRoute | None:
        """The first OCR route (None: no OCR provider)."""
        routes = self.ocr_routes
        return routes[0] if routes else None

    @property
    def llm_routes(self) -> list[LlmRoute]:
        """The providers LLM_PROVIDER allows for structured model calls with the keys at hand, in order."""
        keys: dict[LlmRoute, SecretStr | None] = {
            "openrouter": self.openrouter_api_key,
            "openai": self.openai_api_key,
        }
        if self.llm_provider != "auto":
            return [self.llm_provider] if keys[self.llm_provider] is not None else []
        return [route for route in ("openrouter", "openai") if keys[route] is not None]

    def llm_model(self, role: ModelRole, provider: LlmRoute) -> str:
        """The model id of the classifier or the extractor on a provider."""
        if provider == "openai":
            chosen = self.openai_extractor_model if role == "extractor" else self.openai_classifier_model
            return chosen or self.chat_model
        return self.extractor_model if role == "extractor" else self.classifier_model

    @property
    def openai_ocr_model_name(self) -> str:
        return self.openai_ocr_model or self.chat_model

    @property
    def classifier_configured(self) -> bool:
        return bool(self.llm_routes)

    @property
    def extractor_configured(self) -> bool:
        return bool(self.llm_routes)

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
