import { NextRequest, NextResponse } from "next/server";

export async function POST(req: NextRequest) {
  const backendUrl = process.env.BACKEND_URL;
  const internalAuthSecret = process.env.INTERNAL_AUTH_SECRET;
  const sessionToken = req.cookies.get("session_token")?.value;

  if (backendUrl && internalAuthSecret && sessionToken) {
    try {
      await fetch(`${backendUrl}/api/auth/logout`, {
        method: "POST",
        headers: { "x-internal-auth": internalAuthSecret, "x-session-token": sessionToken },
      });
    } catch (err) {
      // Clear the cookie regardless -- a failed best-effort server-side session delete shouldn't
      // leave the user stuck "logged in" client-side with no way to actually log out.
      console.error("Logout request to backend failed:", err);
    }
  }

  const response = NextResponse.json({ ok: true });
  response.cookies.delete("session_token");
  return response;
}
