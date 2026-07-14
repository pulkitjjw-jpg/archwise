import contextvars
import json
import logging

# Set once per request by main.py's request_context middleware, read here by every log call made
# anywhere during that request (any module, any depth of call stack) -- a contextvar is per-
# asyncio-task, so concurrent requests never see each other's value despite sharing this one
# module-level variable.
request_id_var: contextvars.ContextVar[str | None] = contextvars.ContextVar("request_id", default=None)

# Every attribute a stdlib LogRecord carries by default -- anything else on the record came from
# a caller's `extra={...}` and should be surfaced as its own field in the JSON output.
_STANDARD_LOG_RECORD_KEYS = frozenset(logging.LogRecord("", 0, "", 0, "", (), None).__dict__.keys())


class JsonFormatter(logging.Formatter):
    """Structured JSON logs, one line per record -- plain-text `%(asctime)s %(levelname)s ...`
    was fine read directly off a local terminal but isn't parseable by any log aggregator a real
    deployment would ship logs to. Every record automatically carries the current request's
    correlation id (if any) and any extra= fields a caller passed, so `logger.info("request
    completed", extra={"method": ..., "status": ...})` becomes real structured fields, not string
    interpolation that has to be regexed back apart later."""

    def format(self, record: logging.LogRecord) -> str:
        payload: dict = {
            "timestamp": self.formatTime(record, "%Y-%m-%dT%H:%M:%S%z"),
            "level": record.levelname,
            "logger": record.name,
            "message": record.getMessage(),
        }
        request_id = request_id_var.get()
        if request_id:
            payload["requestId"] = request_id
        for key, value in record.__dict__.items():
            if key not in _STANDARD_LOG_RECORD_KEYS:
                payload[key] = value
        if record.exc_info:
            payload["exception"] = self.formatException(record.exc_info)
        return json.dumps(payload, default=str)


def configure_logging(level: int = logging.INFO) -> None:
    handler = logging.StreamHandler()
    handler.setFormatter(JsonFormatter())
    root = logging.getLogger()
    root.handlers.clear()
    root.addHandler(handler)
    root.setLevel(level)
