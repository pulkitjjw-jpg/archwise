"use client";

// Both the login and signup pages render this same button, calling the same signIn.sso() --
// see the "why" note above handleGoogleAuth in each page. This component is just the shared
// button + divider chrome so it looks identical in both places.
export default function GoogleAuthButton({ onClick, disabled }: { onClick: () => void; disabled?: boolean }) {
  return (
    <>
      <button
        type="button"
        onClick={onClick}
        disabled={disabled}
        className="flex w-full items-center justify-center gap-3 rounded-2xl border border-line bg-white px-5 py-3 text-sm font-semibold text-ink shadow-sm transition-all hover:bg-paper active:scale-[0.98] disabled:opacity-50"
      >
        <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
          <path
            fill="#4285F4"
            d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.9c1.7-1.57 2.68-3.87 2.68-6.62Z"
          />
          <path
            fill="#34A853"
            d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.9-2.26c-.8.54-1.84.86-3.06.86-2.35 0-4.34-1.59-5.05-3.72H.96v2.33A9 9 0 0 0 9 18Z"
          />
          <path fill="#FBBC05" d="M3.95 10.7a5.4 5.4 0 0 1 0-3.4V4.97H.96a9 9 0 0 0 0 8.06l2.99-2.33Z" />
          <path
            fill="#EA4335"
            d="M9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.58C13.46.89 11.43 0 9 0A9 9 0 0 0 .96 4.97l2.99 2.33C4.66 5.17 6.65 3.58 9 3.58Z"
          />
        </svg>
        Continue with Google
      </button>
      <div className="my-1 flex items-center gap-3">
        <div className="h-px flex-1 bg-line" />
        <span className="text-[11px] font-semibold uppercase tracking-wider text-ink-faint">or</span>
        <div className="h-px flex-1 bg-line" />
      </div>
    </>
  );
}
