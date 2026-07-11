from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    database_url: str
    openrouter_api_key: str
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
