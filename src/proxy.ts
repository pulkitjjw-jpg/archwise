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
//
// "/" is handled separately below, NOT added here -- every path starts with "/", so adding it to
// this prefix-matching array would make everything public. It also needs different treatment
// than a plain public page: a logged-in user hitting "/" should be redirected to /dashboard
// (skip the marketing page), not just be let through.
const PUBLIC_PAGE_PREFIXES = ["/login", "/signup", "/forgot-password", "/reset-password", "/share", "/pricing"];

// Surveyed the whole app before writing this: no external fonts (system stack, no next/font
// Google Fonts import), no external scripts, no dangerouslySetInnerHTML anywhere, react-markdown
// is used without rehype-raw so it never renders raw HTML, and every fetch is same-origin (the
// backend is never called directly from the browser -- see the [...path] proxy).
//
// script-src and style-src both need 'unsafe-inline'. style-src's case is unavoidable either way:
// the architecture diagram canvas positions nodes via React's style prop, which serializes to a
// literal style="..." attribute in the server-rendered HTML, and CSP blocks the browser from ever
// applying a markup-level inline style without 'unsafe-inline' (or a matching nonce/hash).
//
// script-src's case was NOT the original plan -- a nonce + 'strict-dynamic' policy (Next.js's own
// documented pattern: thread a per-request nonce through both the request's and response's
// Content-Security-Policy headers) is supposed to let Next's own inline bootstrap/RSC-payload
// scripts through without 'unsafe-inline'. Implemented and live-tested it against this exact app
// (twice, following the docs precisely) and confirmed via the raw served HTML that Next 16 with
// Turbopack never actually stamps nonce="..." onto any of its own injected <script> tags --
// zero nonce attributes anywhere in the response despite the header being threaded through
// exactly as documented. With a real nonce present, browsers ignore 'unsafe-inline' as a
// fallback per the CSP3 spec, so a nonce that Next never uses doesn't just fail to help, it
// actively blocks Next's own scripts outright -- confirmed live as a fully broken (non-
// hydrating) app in production. Whether this is a Turbopack-specific gap or a Next 16 regression
// wasn't chased further; either way it isn't fixable from userland middleware.
//
// Net effect: 'self' still blocks loading scripts from any external/attacker-controlled domain
// (the actually-important part of script-src against a supply-chain or injected-<script src>
// attack), 'unsafe-inline' only loosens the restriction on inline script CONTENT -- and this
// app has no dangerouslySetInnerHTML and no raw-HTML markdown rendering anywhere, so there's no
// known path for attacker-controlled content to reach an inline <script> tag in the first place.
// Real, working protection today beats a theoretically stronger policy that breaks the app.
//
// Gated to production only -- Turbopack dev mode and Fast Refresh have their own script/eval
// needs that aren't worth chasing down for a header with no benefit against a threat model that
// doesn't include the developer's own machine; local `npm run dev` behavior is unaffected.
const CSP_PRODUCTION =
  "default-src 'self'; " +
  "script-src 'self' 'unsafe-inline'; " +
  "style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data: blob:; " +
  "font-src 'self' data:; " +
  // @iconify/react's <Icon> component -- used all over the diagram/component sidebar, per-
  // service icons, etc. -- fetches icon SVG data from these three domains (a documented 3-way
  // failover CDN, same vendor as the @iconify-json/* build dependency) at RUNTIME, not from a
  // local bundle. Missed on first pass (no static `src="http..."` in the JSX to grep for -- this
  // is a network call inside the library's own code) and only surfaced by live-testing: every
  // icon in the app silently rendered blank under a bare 'self' connect-src. Confirmed these are
  // the only three; no other external host is contacted anywhere in the app.
  "connect-src 'self' https://api.iconify.design https://api.unisvg.com https://api.simplesvg.com; " +
  "frame-ancestors 'none'; " +
  "base-uri 'self'; " +
  "form-action 'self'; " +
  "object-src 'none'";

export function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;
  const isApi = pathname.startsWith("/api/");
  const isPublicPage = PUBLIC_PAGE_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`));
  const hasSession = !!req.cookies.get("session_token");

  let response: NextResponse;
  if (pathname === "/") {
    // The public landing page -- but a logged-in user shouldn't land on a sales pitch for a
    // product they already use, so send them straight to their dashboard instead.
    response = hasSession ? NextResponse.redirect(new URL("/dashboard", req.url)) : NextResponse.next();
  } else if (!isApi && !isPublicPage && !hasSession) {
    const loginUrl = new URL("/login", req.url);
    loginUrl.searchParams.set("next", pathname);
    response = NextResponse.redirect(loginUrl);
  } else {
    response = NextResponse.next();
  }

  response.headers.set("X-Frame-Options", "DENY");
  response.headers.set("X-Content-Type-Options", "nosniff");
  if (process.env.NODE_ENV === "production") {
    response.headers.set("Content-Security-Policy", CSP_PRODUCTION);
    response.headers.set("Strict-Transport-Security", "max-age=63072000; includeSubDomains");
  }

  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
