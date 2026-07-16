import { auth } from "@clerk/nextjs/server";
import { NextRequest, NextResponse } from "next/server";

// Thin gateway to the FastAPI backend. Next.js never implements business logic itself here --
// it forwards the request over a network path the browser cannot reach directly (a private
// docker network locally; a platform-level private network in production), attaching a
// shared secret the backend requires on every request as defense-in-depth on top of that
// network isolation. This is the ONLY place that knows BACKEND_URL / INTERNAL_AUTH_SECRET.
export const dynamic = "force-dynamic";

// Headers that must never be forwarded verbatim -- they describe the transport of *this* hop,
// not the one we're relaying through, and forwarding them stale corrupts the proxied response.
const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "host",
  "content-length",
  "transfer-encoding",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "upgrade",
]);

async function proxy(req: NextRequest, { params }: { params: Promise<{ path: string[] }> }) {
  const { path } = await params;
  const backendUrl = process.env.BACKEND_URL;
  const internalAuthSecret = process.env.INTERNAL_AUTH_SECRET;
  if (!backendUrl || !internalAuthSecret) {
    return NextResponse.json({ error: "Backend is not configured" }, { status: 500 });
  }

  // The backend's routers are versioned under /api/v1 (see backend/app/main.py) so a future
  // breaking change has a real migration path -- but the browser-facing surface stays the plain
  // /api/* it always was, so no frontend call site needs to know or care about the backend's
  // internal version. This is the one place that does the translation. /api/health is the one
  // deliberate exception: it's mounted unversioned on the backend (health checks conventionally
  // aren't versioned -- see main.py's comment), so it's forwarded as-is instead of gaining a
  // /v1/ segment it doesn't have.
  const isHealthCheck = path.length === 1 && path[0] === "health";
  const backendPath = isHealthCheck ? `api/${path.join("/")}` : `api/v1/${path.join("/")}`;
  const targetUrl = `${backendUrl}/${backendPath}${req.nextUrl.search}`;

  const forwardHeaders = new Headers();
  req.headers.forEach((value, key) => {
    if (!HOP_BY_HOP_HEADERS.has(key.toLowerCase())) {
      forwardHeaders.set(key, value);
    }
  });
  forwardHeaders.set("x-internal-auth", internalAuthSecret);
  // Set from the real incoming connection, never trusting a client-supplied value (spoofable) --
  // this is what lets the backend's rate limiter key on the actual caller instead of treating
  // every request as coming from this one proxy.
  const realIp = req.headers.get("x-real-ip") || req.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  if (realIp) {
    forwardHeaders.set("x-forwarded-for", realIp);
    forwardHeaders.set("x-real-ip", realIp);
  }
  // The backend has no concept of cookies (it's never called directly by a browser) -- it reads
  // per-user identity from a Bearer token instead. This is the one place that translates between
  // the two: mint the current Clerk session's JWT server-side (auth().getToken() -- cheap, Clerk's
  // own SDK caches it and only re-mints near expiry, not a network call on every proxied request)
  // and forward it as the header the backend's get_current_user dependency verifies with
  // clerk_backend_api.verify_token. Exactly Clerk's documented pattern for a frontend calling a
  // separate backend service, not a custom reimplementation.
  const { getToken } = await auth();
  const sessionToken = await getToken();
  if (sessionToken) {
    forwardHeaders.set("authorization", `Bearer ${sessionToken}`);
  }

  let upstreamRes: Response;
  try {
    upstreamRes = await fetch(targetUrl, {
      method: req.method,
      headers: forwardHeaders,
      body: ["GET", "HEAD"].includes(req.method) ? undefined : req.body,
      // @ts-expect-error -- required by undici when streaming a request body
      duplex: ["GET", "HEAD"].includes(req.method) ? undefined : "half",
      redirect: "manual",
      // The backend's own LLM call walks a 5-model fallback chain (_call_llm_with_fallback_chain),
      // one attempt per model, up to ~30s each for the heaviest call (architecture generation)
      // plus a validation auto-fix pass on the Gemma tier -- worst case (every free tier fails,
      // falls through to the paid Gemini tier) is ~160s. This must stay comfortably above that so
      // the proxy doesn't abort a request the backend would have recovered from.
      signal: AbortSignal.timeout(180_000),
    });
  } catch (err) {
    console.error("Backend proxy request failed:", err);
    return NextResponse.json({ error: "Backend is unreachable" }, { status: 502 });
  }

  const responseHeaders = new Headers();
  upstreamRes.headers.forEach((value, key) => {
    if (!HOP_BY_HOP_HEADERS.has(key.toLowerCase())) {
      responseHeaders.set(key, value);
    }
  });

  return new NextResponse(upstreamRes.body, {
    status: upstreamRes.status,
    headers: responseHeaders,
  });
}

export { proxy as GET, proxy as POST, proxy as PUT, proxy as PATCH, proxy as DELETE };
