"use client";

import * as Sentry from "@sentry/nextjs";
import { useEffect } from "react";

// Next.js App Router's root-level error boundary -- the ONLY boundary that catches an error
// thrown by the root layout (src/app/layout.tsx) itself, e.g. a ClerkProvider init failure.
// Because it replaces the root layout when it fires, it must render its own <html>/<body> (this
// is a hard Next.js requirement, not a style choice) -- src/app/error.tsx below it in the tree
// can rely on the root layout still being intact and doesn't need to.
//
// Kept deliberately simpler than error.tsx: no Tailwind @theme tokens are guaranteed to be
// available here (globals.css is imported by the root layout, which is exactly what may have
// failed to render), so this uses plain inline styles as a self-contained fallback rather than
// risking an unstyled or broken page on top of an already-broken app.
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Safe no-op when Sentry was never initialized (unset NEXT_PUBLIC_SENTRY_DSN) -- see
    // src/instrumentation-client.ts.
    Sentry.captureException(error);
  }, [error]);

  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: "3rem 1.5rem",
          background: "#F6F7FB",
          color: "#12161F",
          fontFamily:
            "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
        }}
      >
        <div
          style={{
            width: "100%",
            maxWidth: "28rem",
            borderRadius: "2rem",
            border: "1px solid rgba(255,255,255,0.7)",
            background: "rgba(255,255,255,0.85)",
            boxShadow: "0 20px 40px rgba(18,22,31,0.12)",
            padding: "2rem",
          }}
        >
          <span
            style={{
              display: "inline-flex",
              alignItems: "center",
              borderRadius: "9999px",
              border: "1px solid rgba(176,42,55,0.25)",
              background: "#FBE7E9",
              color: "#B02A37",
              padding: "0.25rem 0.65rem",
              fontSize: "10px",
              fontWeight: 700,
              textTransform: "uppercase",
              letterSpacing: "0.05em",
            }}
          >
            Application error
          </span>
          <h1 style={{ marginTop: "0.75rem", fontSize: "1.5rem", fontWeight: 900 }}>
            Something went badly wrong
          </h1>
          <p style={{ marginTop: "0.5rem", fontSize: "0.875rem", lineHeight: 1.6, color: "#5B6472" }}>
            The application failed to load. It&apos;s been reported automatically — try
            reloading the page.
          </p>
          <button
            onClick={() => reset()}
            style={{
              marginTop: "1.5rem",
              width: "100%",
              borderRadius: "0.75rem",
              background: "#12161F",
              color: "#fff",
              fontWeight: 700,
              fontSize: "0.875rem",
              padding: "0.65rem 1rem",
              border: "none",
              cursor: "pointer",
            }}
          >
            Reload
          </button>
        </div>
      </body>
    </html>
  );
}
