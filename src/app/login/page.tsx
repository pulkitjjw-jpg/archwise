"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useRef, useState } from "react";
import { useSignIn } from "@clerk/nextjs";
import AuthShell from "@/app/components/AuthShell";
import GoogleAuthButton from "@/app/components/GoogleAuthButton";
import EnterpriseSSOButton from "@/app/components/EnterpriseSSOButton";

type FieldError = { longMessage?: string; message: string } | null;

// Checks field-specific errors first, then falls back to global -- see signup/page.tsx's
// identical helper for why this matters (Clerk returns some real rejection reasons, like a
// breached password, as a field error rather than a global one).
function extractErrorMessage(
  errors: { global: { longMessage?: string; message: string }[] | null; fields: object },
  fieldOrder: string[]
): string {
  const fields = errors.fields as Record<string, FieldError | undefined>;
  for (const field of fieldOrder) {
    const fieldError = fields[field];
    if (fieldError) return fieldError.longMessage || fieldError.message;
  }
  const first = errors.global?.[0];
  return first?.longMessage || first?.message || "Something went wrong. Please try again.";
}

// Headless (not Clerk's prebuilt <SignIn>) so this reads as part of the same product as every
// other screen in the app -- see AuthShell's own comment. "Forgot password?" isn't a separate
// page here: Clerk's reset flow is code-based (email a code, verify it, set a new password), not
// link-based like the old system, so it's a natural fit as three extra steps of this same form
// rather than two more route files.
type Mode = "signin" | "verify-device" | "forgot-request" | "forgot-verify" | "forgot-reset";

function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { signIn, errors, fetchStatus } = useSignIn();
  const busy = fetchStatus === "fetching";

  const [mode, setMode] = useState<Mode>("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [error, setError] = useState("");

  // `signIn` read synchronously right after an `await signIn.password(...)`/`verifyEmailCode(...)`
  // is NOT reliable with this SDK version: confirmed live (via the raw network response body vs.
  // signIn.status logged immediately afterward) that the closure can still read a stale snapshot
  // -- e.g. "needs_identifier" -- even though the API response for the SAME call already says
  // "needs_client_trust" or "complete". signInRef is kept pointed at the latest object via this
  // effect (which DOES fire on every real update, confirmed live), and both waitForSignInUpdate
  // below and the finalize effect read through the ref instead of the closure value.
  const signInRef = useRef(signIn);
  useEffect(() => {
    signInRef.current = signIn;
  }, [signIn]);

  // Polls the ref (not the closure) for a small number of animation-frame-ish ticks -- give
  // pending re-renders a chance to land and update the ref before giving up. 3s max.
  const waitForSignInUpdate = async (predicate: (s: typeof signIn) => boolean) => {
    for (let i = 0; i < 20; i++) {
      if (predicate(signInRef.current)) return signInRef.current;
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    return signInRef.current;
  };

  const finalizedRef = useRef(false);
  const finalizeAndGo = () => {
    if (finalizedRef.current) return;
    finalizedRef.current = true;
    signInRef.current.finalize({
      // decorateUrl (not a plain router.push) is required, not optional -- it's what makes Clerk
      // refresh the session cookie correctly before navigating (Safari ITP, and observed live to
      // matter on Chromium too: skipping it left the freshly-created session invisible to
      // clerkMiddleware's very next request, bouncing straight back to /login as if signed out).
      navigate: ({ decorateUrl }) => {
        const url = decorateUrl(searchParams.get("next") || "/dashboard");
        if (url.startsWith("http")) {
          window.location.href = url;
        } else {
          router.push(url);
        }
      },
    });
  };
  // Belt-and-suspenders: also finalize reactively if signIn.status reaches "complete" via a
  // render this component sees directly (covers the case where a render happens outside of
  // waitForSignInUpdate's polling window, e.g. right as the poll loop gives up).
  useEffect(() => {
    if (signIn.status === "complete") finalizeAndGo();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signIn.status]);

  // signIn.sso() is the same call whether the user clicks this from the sign-in or the sign-up
  // page (see signup/page.tsx's identical handler) -- Google OAuth doesn't distinguish "sign in"
  // from "sign up" up front, so Clerk always starts it as a sign-in attempt and /sso-callback
  // decides whether to transfer it into a sign-up if no matching account exists yet. On success
  // this never returns -- the browser navigates away to Google -- so the only real outcome to
  // handle here is the error case (e.g. Google not yet enabled as a connection in the Clerk
  // dashboard).
  const handleGoogleAuth = async () => {
    setError("");
    const { error: ssoError } = await signIn.sso({
      strategy: "oauth_google",
      redirectCallbackUrl: "/sso-callback",
      redirectUrl: "/dashboard",
    });
    if (ssoError) {
      console.error("[login] signIn.sso() error:", ssoError);
      setError(extractErrorMessage(errors, []));
    }
  };

  // Enterprise SSO (SAML) -- same signIn.sso() call as Google, but the "enterprise_sso" strategy
  // additionally requires an identifier (the user's work email) so Clerk can resolve which
  // Enterprise Connection/IdP to redirect to; there's no single "SSO" redirect target the way
  // there is for oauth_google. Also always a signIn.sso() call, even for a brand-new user -- same
  // "sign-in first, /sso-callback transfers to a real sign-up if needed" design as Google. On
  // success this never returns -- the browser navigates away to the customer's IdP -- so the only
  // real outcome to handle here is the error case, most commonly no Enterprise Connection
  // matching this email's domain (e.g. the admin hasn't configured/enabled one in the Clerk
  // dashboard yet). "identifier" is included in extractErrorMessage's field order because Clerk
  // returns that specific rejection as an identifier field error, not a global one -- confirmed
  // against handleForgotRequest below, which resolves an identifier the same way and already
  // relies on this same field-error convention.
  const handleEnterpriseSSO = async (ssoEmail: string) => {
    setError("");
    const { error: ssoError } = await signIn.sso({
      strategy: "enterprise_sso",
      identifier: ssoEmail,
      redirectCallbackUrl: "/sso-callback",
      redirectUrl: "/dashboard",
    });
    if (ssoError) {
      console.error("[login] signIn.sso() enterprise_sso error:", ssoError);
      setError(extractErrorMessage(errors, ["identifier"]));
    }
  };

  const handleSignIn = async () => {
    setError("");
    const { error: signInError } = await signIn.password({ emailAddress: email, password });
    if (signInError) {
      // signIn.password() resolves the identifier before attempting the password, so
      // supportedFirstFactors is populated even on failure -- confirmed live: an account created
      // via "Continue with Google" has no password on file, and Clerk correctly rejects a
      // password attempt for it with a fairly opaque "verification strategy is not valid"
      // message. Rather than surface that raw text, check whether password genuinely isn't a
      // valid strategy for this identifier (vs. e.g. a real wrong-password case, which SHOULD
      // show the generic error) and point the user at Google instead -- Clerk's own docs
      // recommend exactly this supportedFirstFactors check over parsing error text/codes.
      const passwordSupported = signInRef.current.supportedFirstFactors?.some((f) => f.strategy === "password");
      const googleSupported = signInRef.current.supportedFirstFactors?.some((f) => f.strategy === "oauth_google");
      if (passwordSupported === false && googleSupported) {
        setError("This email is linked to a Google account. Use “Continue with Google” above instead.");
      } else {
        setError(extractErrorMessage(errors, ["identifier", "password"]));
      }
      return;
    }
    const current = await waitForSignInUpdate((s) => s.status !== "needs_identifier");
    if (current.status === "complete") {
      finalizeAndGo();
      return;
    }
    // "needs_client_trust" -- Clerk's new-device check, distinct from "complete": signing in from
    // a browser/device Clerk hasn't seen before for this account requires one extra emailed-code
    // step before the session actually activates. Confirmed live: without this branch, a sign-in
    // from a new device silently did nothing (no error, no navigation) -- the password itself was
    // correct and the API call succeeded, there was just an unhandled intermediate status.
    if (current.status === "needs_client_trust") {
      const emailCodeFactor = current.supportedSecondFactors.find((f) => f.strategy === "email_code");
      if (emailCodeFactor) {
        const { error: sendError } = await signIn.mfa.sendEmailCode();
        if (sendError) {
          setError(extractErrorMessage(errors, ["code"]));
          return;
        }
        setMode("verify-device");
      } else {
        setError("This device isn't recognized and no verification method is available. Please try again.");
      }
      return;
    }
    setError("We couldn't sign you in. Please try again.");
  };

  const handleVerifyDevice = async () => {
    setError("");
    const { error: verifyError } = await signIn.mfa.verifyEmailCode({ code });
    if (verifyError) {
      setError(extractErrorMessage(errors, ["code"]));
      return;
    }
    const current = await waitForSignInUpdate((s) => s.status === "complete");
    if (current.status === "complete") {
      finalizeAndGo();
    } else {
      setError("We couldn't verify this device. Please try again.");
    }
  };

  const handleForgotRequest = async () => {
    setError("");
    const { error: createError } = await signIn.create({ identifier: email });
    if (createError) {
      setError(extractErrorMessage(errors, ["identifier"]));
      return;
    }
    const { error: sendError } = await signIn.resetPasswordEmailCode.sendCode();
    if (sendError) {
      setError(extractErrorMessage(errors, ["identifier"]));
      return;
    }
    setMode("forgot-verify");
  };

  const handleForgotVerify = async () => {
    setError("");
    const { error: verifyError } = await signIn.resetPasswordEmailCode.verifyCode({ code });
    if (verifyError) {
      setError(extractErrorMessage(errors, ["code"]));
      return;
    }
    setMode("forgot-reset");
  };

  const handleForgotReset = async () => {
    setError("");
    const { error: submitError } = await signIn.resetPasswordEmailCode.submitPassword({
      password: newPassword,
      signOutOfOtherSessions: true,
    });
    if (submitError) {
      setError(extractErrorMessage(errors, ["password"]));
      return;
    }
    const current = await waitForSignInUpdate((s) => s.status === "complete");
    if (current.status === "complete") {
      finalizeAndGo();
    } else {
      setError("We couldn't sign you in. Please try again.");
    }
  };

  const startOver = () => {
    signIn.reset();
    setMode("signin");
    setCode("");
    setNewPassword("");
    setError("");
  };

  if (mode === "verify-device") {
    return (
      <AuthShell
        eyebrow="🔑 Verify Device"
        title="Confirm it's you"
        subtitle={`We don't recognize this device. We sent a code to ${email} -- enter it below to finish signing in.`}
        footer={
          <button onClick={startOver} className="font-bold text-accent-ink hover:underline">
            Back to sign in
          </button>
        }
      >
        <form action={handleVerifyDevice} className="flex flex-col gap-4">
          <div>
            <label htmlFor="code" className="block text-xs font-semibold uppercase tracking-wider text-ink-muted">
              Verification code
            </label>
            <input
              type="text"
              id="code"
              inputMode="numeric"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              disabled={busy}
              className="mt-2 w-full rounded-2xl border border-line bg-white px-4 py-3 text-sm text-ink shadow-sm focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent disabled:opacity-50"
              required
            />
          </div>
          {error && <p className="text-xs font-medium text-danger">{error}</p>}
          <button
            type="submit"
            disabled={busy}
            className="mt-2 flex w-full items-center justify-center rounded-2xl bg-accent px-5 py-3 text-sm font-semibold text-white shadow-md transition-all hover:bg-accent-ink active:scale-[0.98] disabled:opacity-50"
          >
            {busy ? "Verifying..." : "Verify & Sign In"}
          </button>
          <button
            type="button"
            onClick={() => signIn.mfa.sendEmailCode()}
            className="text-xs font-semibold text-accent-ink hover:underline"
          >
            Didn&apos;t get a code? Send another
          </button>
        </form>
      </AuthShell>
    );
  }

  if (mode === "forgot-request") {
    return (
      <AuthShell
        eyebrow="🔑 Reset Password"
        title="Forgot your password?"
        subtitle="Enter your email and we'll send you a code to reset it."
        footer={
          <button onClick={startOver} className="font-bold text-accent-ink hover:underline">
            Back to sign in
          </button>
        }
      >
        <form action={handleForgotRequest} className="flex flex-col gap-4">
          <div>
            <label htmlFor="email" className="block text-xs font-semibold uppercase tracking-wider text-ink-muted">
              Email
            </label>
            <input
              type="email"
              id="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              disabled={busy}
              autoComplete="email"
              className="mt-2 w-full rounded-2xl border border-line bg-white px-4 py-3 text-sm text-ink shadow-sm focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent disabled:opacity-50"
              required
            />
          </div>
          {error && <p className="text-xs font-medium text-danger">{error}</p>}
          <button
            type="submit"
            disabled={busy}
            className="mt-2 flex w-full items-center justify-center rounded-2xl bg-accent px-5 py-3 text-sm font-semibold text-white shadow-md transition-all hover:bg-accent-ink active:scale-[0.98] disabled:opacity-50"
          >
            {busy ? "Sending..." : "Send Reset Code"}
          </button>
        </form>
      </AuthShell>
    );
  }

  if (mode === "forgot-verify") {
    return (
      <AuthShell
        eyebrow="🔑 Reset Password"
        title="Check your email"
        subtitle={`We sent a code to ${email}. Enter it below.`}
        footer={
          <button onClick={startOver} className="font-bold text-accent-ink hover:underline">
            Back to sign in
          </button>
        }
      >
        <form action={handleForgotVerify} className="flex flex-col gap-4">
          <div>
            <label htmlFor="code" className="block text-xs font-semibold uppercase tracking-wider text-ink-muted">
              Reset code
            </label>
            <input
              type="text"
              id="code"
              inputMode="numeric"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              disabled={busy}
              className="mt-2 w-full rounded-2xl border border-line bg-white px-4 py-3 text-sm text-ink shadow-sm focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent disabled:opacity-50"
              required
            />
          </div>
          {error && <p className="text-xs font-medium text-danger">{error}</p>}
          <button
            type="submit"
            disabled={busy}
            className="mt-2 flex w-full items-center justify-center rounded-2xl bg-accent px-5 py-3 text-sm font-semibold text-white shadow-md transition-all hover:bg-accent-ink active:scale-[0.98] disabled:opacity-50"
          >
            {busy ? "Verifying..." : "Verify Code"}
          </button>
          <button
            type="button"
            onClick={() => signIn.resetPasswordEmailCode.sendCode()}
            className="text-xs font-semibold text-accent-ink hover:underline"
          >
            Didn&apos;t get a code? Send another
          </button>
        </form>
      </AuthShell>
    );
  }

  if (mode === "forgot-reset") {
    return (
      <AuthShell eyebrow="🔑 Reset Password" title="Choose a new password" subtitle="At least 8 characters.">
        <form action={handleForgotReset} className="flex flex-col gap-4">
          <div>
            <label htmlFor="newPassword" className="block text-xs font-semibold uppercase tracking-wider text-ink-muted">
              New password
            </label>
            <input
              type="password"
              id="newPassword"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              disabled={busy}
              autoComplete="new-password"
              minLength={8}
              className="mt-2 w-full rounded-2xl border border-line bg-white px-4 py-3 text-sm text-ink shadow-sm focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent disabled:opacity-50"
              required
            />
          </div>
          {error && <p className="text-xs font-medium text-danger">{error}</p>}
          <button
            type="submit"
            disabled={busy}
            className="mt-2 flex w-full items-center justify-center rounded-2xl bg-accent px-5 py-3 text-sm font-semibold text-white shadow-md transition-all hover:bg-accent-ink active:scale-[0.98] disabled:opacity-50"
          >
            {busy ? "Saving..." : "Update Password & Sign In"}
          </button>
        </form>
      </AuthShell>
    );
  }

  return (
    <AuthShell
      eyebrow="🔑 Sign In"
      title="Welcome back"
      subtitle="Sign in to pick up where you left off."
      footer={
        <>
          Don&apos;t have an account?{" "}
          <Link href="/signup" className="font-bold text-accent-ink hover:underline">
            Create one
          </Link>
        </>
      }
    >
      <form action={handleSignIn} className="flex flex-col gap-4">
        <GoogleAuthButton onClick={handleGoogleAuth} disabled={busy} />
        <div>
          <label htmlFor="email" className="block text-xs font-semibold uppercase tracking-wider text-ink-muted">
            Email
          </label>
          <input
            type="email"
            id="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            disabled={busy}
            autoComplete="email"
            className="mt-2 w-full rounded-2xl border border-line bg-white px-4 py-3 text-sm text-ink shadow-sm focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent disabled:opacity-50"
            required
          />
        </div>
        <div>
          <div className="flex items-center justify-between">
            <label htmlFor="password" className="block text-xs font-semibold uppercase tracking-wider text-ink-muted">
              Password
            </label>
            <button
              type="button"
              onClick={() => {
                setError("");
                setMode("forgot-request");
              }}
              className="text-xs font-semibold text-accent-ink hover:underline"
            >
              Forgot password?
            </button>
          </div>
          <input
            type="password"
            id="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            disabled={busy}
            autoComplete="current-password"
            className="mt-2 w-full rounded-2xl border border-line bg-white px-4 py-3 text-sm text-ink shadow-sm focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent disabled:opacity-50"
            required
          />
        </div>

        {error && <p className="text-xs font-medium text-danger">{error}</p>}

        <button
          type="submit"
          disabled={busy}
          className="mt-2 flex w-full items-center justify-center rounded-2xl bg-accent px-5 py-3 text-sm font-semibold text-white shadow-md transition-all hover:bg-accent-ink active:scale-[0.98] disabled:opacity-50"
        >
          {busy ? (
            <span className="flex items-center gap-2">
              <span className="h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent" />
              Signing in...
            </span>
          ) : (
            "Sign In"
          )}
        </button>
      </form>

      {/* Deliberately outside the <form> above -- see EnterpriseSSOButton's own comment for why
          it needs its own <form> rather than sharing this one. */}
      <div className="mt-4">
        <EnterpriseSSOButton onSubmit={handleEnterpriseSSO} disabled={busy} />
      </div>
    </AuthShell>
  );
}

export default function LoginPage() {
  return (
    <Suspense>
      <LoginForm />
    </Suspense>
  );
}
