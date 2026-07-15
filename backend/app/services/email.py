import base64
import logging

import resend

from app.config import settings

logger = logging.getLogger("app.services.email")

# Resend's own hard limit is higher, but a much tighter app-level cap keeps email delivery fast
# and reliable and gives users a clear, early error instead of a slow timeout or a bounced
# message -- exports that exceed this are exactly the ones a direct download already handles
# fine, so there's no real loss in steering people there instead.
MAX_ATTACHMENT_SIZE_BYTES = 10 * 1024 * 1024  # 10 MB

# Resend's shared sending domain -- used until a custom domain is verified for this project (see
# app/config.py's resend_api_key comment). Every "from" address on this domain works out of the
# box with no DNS setup, which is exactly why it's the right choice for right now.
FROM_ADDRESS = "Archwise <onboarding@resend.dev>"


class ExportEmailError(Exception):
    """Raised for any export-email failure that should reach the user as a friendly message
    (missing config, oversized attachment, or a Resend API failure) -- callers in
    routers/export.py catch this and turn it into an HTTPException, never a raw 500."""


def _build_email_html(project_name: str, export_label: str, attachment_filename: str) -> str:
    # Deliberately plain and self-contained (no external images/fonts -- email clients strip or
    # block most of that anyway) rather than a heavy HTML template; the goal is "obviously from
    # Archwise and clearly says what's attached," not a marketing email.
    return f"""\
<div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 480px; margin: 0 auto; padding: 32px 24px; color: #12161F;">
  <p style="font-size: 13px; font-weight: 700; letter-spacing: 0.05em; text-transform: uppercase; color: #4638C2; margin: 0 0 16px;">Archwise</p>
  <h1 style="font-size: 20px; font-weight: 800; margin: 0 0 12px;">Your export is attached</h1>
  <p style="font-size: 14px; line-height: 1.6; color: #5B6472; margin: 0 0 8px;">
    Here's the {export_label} export for <strong style="color: #12161F;">{project_name}</strong>, attached to this email as
    <code style="background: #F6F7FB; padding: 2px 6px; border-radius: 4px; font-size: 13px;">{attachment_filename}</code>.
  </p>
  <p style="font-size: 12px; line-height: 1.6; color: #8891A0; margin: 24px 0 0; border-top: 1px solid #E2E6ED; padding-top: 16px;">
    You're receiving this because you requested an emailed copy of this export from your Archwise dashboard.
  </p>
</div>"""


async def send_export_email(
    *,
    to_email: str,
    project_name: str,
    export_label: str,
    attachment_filename: str,
    attachment_bytes: bytes,
    attachment_content_type: str,
) -> None:
    if not settings.resend_api_key:
        # Not a user-facing config detail (they don't know or care what Resend is), but honest
        # about the actual state -- surfaced as a generic "try downloading instead" by the router.
        raise ExportEmailError("Email delivery is not configured.")
    if len(attachment_bytes) > MAX_ATTACHMENT_SIZE_BYTES:
        raise ExportEmailError(
            f"This export is too large to email ({len(attachment_bytes) / (1024 * 1024):.1f} MB, "
            f"limit is {MAX_ATTACHMENT_SIZE_BYTES // (1024 * 1024)} MB). Please use the direct download instead."
        )

    resend.api_key = settings.resend_api_key
    try:
        await resend.Emails.send_async(
            {
                "from": FROM_ADDRESS,
                "to": to_email,
                "subject": f"Your {export_label} export — {project_name}",
                "html": _build_email_html(project_name, export_label, attachment_filename),
                "attachments": [
                    {
                        "filename": attachment_filename,
                        "content": base64.b64encode(attachment_bytes).decode("ascii"),
                        "content_type": attachment_content_type,
                    }
                ],
            }
        )
    except Exception as exc:
        logger.exception("Resend export-email send failed for %s (%s)", to_email, export_label)
        raise ExportEmailError("We couldn't send that email. Please try again in a moment.") from exc
