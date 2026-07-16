"use client";

import { useState } from "react";

// Both login and signup render this same toggle, calling the same signIn.sso({ strategy:
// "enterprise_sso" }) -- see the handleEnterpriseSSO handler in each page. Unlike
// GoogleAuthButton, enterprise SSO needs an identifier (the user's work email) so Clerk knows
// which Enterprise Connection/IdP to route to, so this can't be a single no-input button.
// Starts collapsed as a plain link rather than a third prominent button competing with Google
// and email/password for attention; expands to a small inline email field on click.
//
// Deliberately rendered as a sibling OUTSIDE the page's main <form> (see login/signup usage),
// not nested inside it. It needs its own <form> so pressing Enter in the email field submits
// this widget instead of falling through to the outer form's submit button (e.g. "Sign In",
// which would try to sign in with an empty password) -- and a <form> nested inside another
// <form> is invalid HTML5 that browsers handle inconsistently, so it can't share the outer one.
export default function EnterpriseSSOButton({
  onSubmit,
  disabled,
}: {
  onSubmit: (email: string) => void;
  disabled?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const [email, setEmail] = useState("");

  if (!expanded) {
    return (
      <button
        type="button"
        onClick={() => setExpanded(true)}
        disabled={disabled}
        className="text-center text-xs font-semibold text-accent-ink hover:underline disabled:opacity-50"
      >
        Sign in with your company SSO
      </button>
    );
  }

  return (
    <form
      action={() => {
        if (email) onSubmit(email);
      }}
      className="flex flex-col gap-2 rounded-2xl border border-line bg-paper/60 p-3"
    >
      <label htmlFor="sso-email" className="block text-xs font-semibold uppercase tracking-wider text-ink-muted">
        Work email
      </label>
      <div className="flex gap-2">
        <input
          type="email"
          id="sso-email"
          name="sso-email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          disabled={disabled}
          placeholder="you@company.com"
          autoComplete="email"
          required
          className="min-w-0 flex-1 rounded-xl border border-line bg-white px-3 py-2 text-sm text-ink shadow-sm focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent disabled:opacity-50"
        />
        <button
          type="submit"
          disabled={disabled || !email}
          className="shrink-0 rounded-xl border border-line bg-white px-4 py-2 text-xs font-semibold text-ink shadow-sm transition-all hover:bg-paper active:scale-[0.98] disabled:opacity-50"
        >
          Continue
        </button>
      </div>
    </form>
  );
}
