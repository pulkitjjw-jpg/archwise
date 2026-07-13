import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

// Redirects unauthenticated page navigation to /login. This is a UX optimization, NOT the
// security boundary -- it only checks whether a session_token cookie is PRESENT (the Edge runtime
// has no cheap way to validate it against Redis). The real authorization happens per-request in
// the backend's get_current_user dependency (see backend/app/dependencies.py), which is what
// actually protects data even if this proxy were bypassed entirely.
//
// Deliberately does NOT gate /api/* -- API auth is enforced entirely by the backend, per route,
// so there's exactly one place that knows which endpoints need auth instead of two that could
// drift out of sync.
const PUBLIC_PAGE_PREFIXES = ["/login", "/signup", "/forgot-password", "/reset-password", "/share"];

export function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;
  const isApi = pathname.startsWith("/api/");
  const isPublicPage = PUBLIC_PAGE_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`));

  let response: NextResponse;
  if (!isApi && !isPublicPage && !req.cookies.get("session_token")) {
    const loginUrl = new URL("/login", req.url);
    loginUrl.searchParams.set("next", pathname);
    response = NextResponse.redirect(loginUrl);
  } else {
    response = NextResponse.next();
  }

  // Cheap, safe security headers with no risk of breaking the app's own heavy dynamic/inline
  // styling (a full Content-Security-Policy is deferred -- see the Phase A audit -- since getting
  // it right needs live verification against the architecture canvas, not bundled in here).
  response.headers.set("X-Frame-Options", "DENY");
  response.headers.set("X-Content-Type-Options", "nosniff");

  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
