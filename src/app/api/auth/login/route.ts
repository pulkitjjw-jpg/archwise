import { NextRequest, NextResponse } from "next/server";

// The backend never sets cookies itself (it's never called directly by a browser, see the
// catch-all proxy's own comment) -- this route is the one place that takes the sessionToken the
// backend hands back on a successful login and turns it into the httpOnly cookie every other
// request reads from. Not routed through the catch-all proxy since that route is a dumb pass-
// through with no cookie-setting side effect; this one deliberately isn't dumb.
const SESSION_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 30; // 30 days, matches the backend's session TTL

export async function POST(req: NextRequest) {
  const backendUrl = process.env.BACKEND_URL;
  const internalAuthSecret = process.env.INTERNAL_AUTH_SECRET;
  if (!backendUrl || !internalAuthSecret) {
    return NextResponse.json({ error: "Backend is not configured" }, { status: 500 });
  }

  const body = await req.json();

  let upstreamRes: Response;
  try {
    upstreamRes = await fetch(`${backendUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-internal-auth": internalAuthSecret },
      body: JSON.stringify(body),
    });
  } catch (err) {
    console.error("Login request failed:", err);
    return NextResponse.json({ error: "Backend is unreachable" }, { status: 502 });
  }

  const data = await upstreamRes.json();
  if (!upstreamRes.ok) {
    return NextResponse.json(data, { status: upstreamRes.status });
  }

  const response = NextResponse.json({ user: data.user });
  response.cookies.set("session_token", data.sessionToken, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_COOKIE_MAX_AGE_SECONDS,
  });
  return response;
}
