from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    database_url: str
    openrouter_api_key: str
    # Ordered, comma-separated OpenRouter model slugs every LLM call in the backend falls back
    # through (see app/services/llm.py's _call_llm_with_fallback_chain, the single shared call
    # site every brainstorm/extraction/generation/RAG-citation function routes through). Each
    # model gets exactly ONE attempt -- on any failure (network error, timeout, unparseable
    # output) the chain moves to the next slug immediately, never retrying the same model. The
    # last entry is treated as the paid "last resort" tier and its use is logged at WARNING so
    # free-tier insufficiency is visible in monitoring. One env var, so re-ordering/swapping
    # models is a config change, never a code change -- confirm every slug against OpenRouter's
    # own model list (https://openrouter.ai/api/v1/models) before changing this, provider model
    # strings are not guessable and a wrong slug silently drops that whole tier.
    llm_model_chain: str = (
        "openai/gpt-oss-120b:free,"
        "google/gemma-4-31b-it:free,"
        "nvidia/nemotron-3-ultra-550b-a55b:free,"
        "qwen/qwen3-coder:free,"
        "google/gemini-2.5-flash"
    )
    # Subset of the chain above (comma-separated, must match slugs exactly) that gets an extra
    # validation + auto-fix pass before its output is trusted, instead of being accepted or
    # rejected outright like every other tier. Evaluated against openai/gpt-oss-120b:free and
    # confirmed as the free-tier model most prone to subtly malformed JSON in practice.
    llm_validated_models: str = "google/gemma-4-31b-it:free"
    # Fast/free model used ONLY to reformat/repair a validated tier's malformed output (fix small
    # JSON syntax problems or fill 1-2 missing fields) -- never asked to regenerate content from
    # scratch, so it can be small and quick rather than matching the primary call's capability.
    llm_validation_fix_model: str = "openai/gpt-oss-120b:free"
    # Per-model-attempt timeout. Deliberately NOT "a few seconds" flat: real successful calls
    # (e.g. architecture generation on Gemini) have taken ~15s even when working correctly, and a
    # too-aggressive timeout would falsely cascade away from a model that was simply still
    # generating a large response. Individual call sites may override this for known-heavy calls.
    llm_per_model_timeout_seconds: float = 15.0
    llm_validation_fix_timeout_seconds: float = 10.0
    # Architecture generation is the heaviest call in the app -- per-component cloudMappings for
    # every provider, for every component in the architecture -- and got heavier again as more
    # component types (lb/dns/monitoring/notification, WAF config) were added. A live dogfooding
    # session measured a real successful completion (via gemini-2.5-flash, the paid last-resort
    # tier) at 66-73s for a moderately complex project even BEFORE those additions; the previous
    # hardcoded 30.0s budget in llm.py was cutting every attempt off mid-generation, not just under
    # rare load -- confirmed live: every one of 8 consecutive real generation attempts (across two
    # different architectures) failed with "timed out after 30.0s" on the SAME two models
    # (nvidia/nemotron and the gemini-2.5-flash paid fallback) that are the only ones in the chain
    # that don't fail near-instantly for an unrelated reason (a deprecated free-tier model slug, or
    # upstream rate limiting). 100s gives real headroom above the measured 66-73s baseline.
    llm_architecture_generation_timeout_seconds: float = 100.0
    redis_url: str = "redis://localhost:6379/0"

    # Clerk (replaces the old bcrypt+Redis-session auth system). clerk_secret_key is used both
    # for the Backend API client (fetching a new user's email on first sight, see
    # app/services/clerk_sync.py) and as a fallback JWKS-retrieval credential; clerk_jwt_key is
    # what actually makes session verification networkless on every request (see
    # app/dependencies.py's get_current_user) -- from the Clerk dashboard under
    # API Keys -> Advanced -> JWT public key.
    clerk_secret_key: str
    clerk_jwt_key: str

    # Resend (export-delivery emails only -- Clerk handles all auth-related emails natively, so
    # this is scoped to the "Email to me" export feature, not signup/login/password-reset).
    # Optional/empty-string default so the backend still starts without it configured; the export
    # email endpoint itself 500s with a clear message if a send is attempted with no key set.
    # Sender uses Resend's shared onboarding domain (onboarding@resend.dev) until a custom domain
    # is configured -- see app/services/email.py.
    resend_api_key: str = ""

    @property
    def llm_chain(self) -> list[str]:
        return [m.strip() for m in self.llm_model_chain.split(",") if m.strip()]

    @property
    def llm_validated_model_set(self) -> set[str]:
        return {m.strip() for m in self.llm_validated_models.split(",") if m.strip()}

    @property
    def async_database_url(self) -> str:
        """Accept a plain postgresql:// URL and use the asyncpg driver under the hood,
        so the env var stays a normal Postgres connection string."""
        if self.database_url.startswith("postgresql://"):
            return self.database_url.replace("postgresql://", "postgresql+asyncpg://", 1)
        return self.database_url

    # Shared secret Next.js's proxy must send on every request. Defense-in-depth on top of
    # network isolation -- if the private network is ever misconfigured, this is the backstop.
    internal_auth_secret: str

    environment: str = "development"

    # Sentry error tracking (see app/observability.py). Optional/empty-string default -- the app
    # has no real Sentry account/DSN yet, so this must stay fully inert (sentry_sdk.init() is
    # simply never called) until a real DSN is provided. Never crash/fail startup over this being
    # unset; just skip initialization the same way resend_api_key is skipped above.
    sentry_dsn: str = ""

    @property
    def sentry_enabled(self) -> bool:
        return bool(self.sentry_dsn.strip())


settings = Settings()  # type: ignore[call-arg]
