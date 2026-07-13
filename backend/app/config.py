from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    database_url: str
    openrouter_api_key: str
    # The OpenRouter model slug every LLM call in the backend uses (see app/services/llm.py's
    # _call_llm_with_retry, the single shared call site every brainstorm/extraction/generation/
    # RAG-citation function routes through) -- one env var, so switching models is a config change,
    # never a code change. Confirm the exact slug against OpenRouter's own model list
    # (https://openrouter.ai/api/v1/models) before changing this -- provider model strings are not
    # guessable and a wrong slug fails every LLM call in the app.
    # openai/gpt-oss-120b:free was evaluated for the ~100-user free-tier test and reverted: it
    # failed architecture generation (the app's most JSON-structurally-complex call) in all 3
    # end-to-end attempts, even with 5-attempt/backoff retry hardening -- a mix of malformed JSON
    # syntax, shared-pool 429s, and null/malformed response bodies. See git history for details.
    llm_model: str = "google/gemini-2.5-flash"
    redis_url: str = "redis://localhost:6379/0"

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


settings = Settings()  # type: ignore[call-arg]
