import { NextRequest, NextResponse } from "next/server";

// Same shape as login/route.ts -- the backend hands back a sessionToken, this route is where it
// becomes an httpOnly cookie. See that file's comment for why this isn't just the catch-all proxy.
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
    upstreamRes = await fetch(`${backendUrl}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-internal-auth": internalAuthSecret },
      body: JSON.stringify(body),
    });
  } catch (err) {
    console.error("Register request failed:", err);
    return NextResponse.json({ error: "Backend is unreachable" }, { status: 502 });
  }

  const data = await upstreamRes.json();
  if (!upstreamRes.ok) {
    return NextResponse.json(data, { status: upstreamRes.status });
  }

  const response = NextResponse.json({ user: data.user }, { status: 201 });
  response.cookies.set("session_token", data.sessionToken, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_COOKIE_MAX_AGE_SECONDS,
  });
  return response;
}
