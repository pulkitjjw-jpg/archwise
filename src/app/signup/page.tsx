"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { useSignIn, useSignUp } from "@clerk/nextjs";
import AuthShell from "@/app/components/AuthShell";
import GoogleAuthButton from "@/app/components/GoogleAuthButton";
import EnterpriseSSOButton from "@/app/components/EnterpriseSSOButton";

type FieldError = { longMessage?: string; message: string } | null;

// Checks field-specific errors first (e.g. Clerk's "this password has appeared in a data breach"
// rejection comes back as a password FIELD error, not a global one -- missing this meant real
// rejection reasons were silently replaced with a generic "Something went wrong" message).
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

export default function SignupPage() {
  const router = useRouter();
  const { signUp, errors, fetchStatus } = useSignUp();
  // Google (and any other OAuth) always goes through signIn.sso(), even from this page -- see
  // handleGoogleAuth below and its identical counterpart in login/page.tsx for why.
  const { signIn, errors: signInErrors } = useSignIn();
  const busy = fetchStatus === "fetching";

  const [step, setStep] = useState<"details" | "verify">("details");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState("");

  // Reacts to signUp.status becoming "complete" via an effect rather than reading it synchronously
  // right after `await signUp.verifications.verifyEmailCode(...)` -- see login/page.tsx's
  // identical, more detailed comment on its finalizedRef effect: confirmed live that a synchronous
  // post-await read of this SDK's Signal-based resource returns a stale value even though the API
  // call itself already completed successfully. finalizedRef stops this firing more than once.
  const finalizedRef = useRef(false);
  useEffect(() => {
    if (signUp.status !== "complete" || finalizedRef.current) return;
    finalizedRef.current = true;
    signUp.finalize({
      navigate: ({ decorateUrl }) => {
        const url = decorateUrl("/dashboard");
        if (url.startsWith("http")) {
          window.location.href = url;
        } else {
          router.push(url);
        }
      },
    });
    // Deliberately depends only on signUp.status, not [signUp, router] -- see login/page.tsx's
    // identical effect for why.
  }, [signUp.status]);

  // Same handler as login/page.tsx's -- Google OAuth doesn't distinguish sign-up from sign-in up
  // front, so this always starts as a signIn.sso() attempt; /sso-callback transfers it into an
  // actual sign-up if no matching Clerk account exists yet. Doesn't return on success -- the
  // browser navigates away to Google.
  const handleGoogleAuth = async () => {
    setError("");
    const { error: ssoError } = await signIn.sso({
      strategy: "oauth_google",
      redirectCallbackUrl: "/sso-callback",
      redirectUrl: "/dashboard",
    });
    if (ssoError) {
      console.error("[signup] signIn.sso() error:", ssoError);
      setError(extractErrorMessage(signInErrors, []));
    }
  };

  // Same handler as login/page.tsx's identical one -- enterprise_sso needs an identifier (work
  // email) so Clerk can resolve which Enterprise Connection/IdP to route to, unlike Google's
  // single no-input redirect. Always a signIn.sso() call, even from signup -- see handleGoogleAuth
  // above for why. Doesn't return on success -- the browser navigates away to the customer's IdP.
  const handleEnterpriseSSO = async (ssoEmail: string) => {
    setError("");
    const { error: ssoError } = await signIn.sso({
      strategy: "enterprise_sso",
      identifier: ssoEmail,
      redirectCallbackUrl: "/sso-callback",
      redirectUrl: "/dashboard",
    });
    if (ssoError) {
      console.error("[signup] signIn.sso() enterprise_sso error:", ssoError);
      setError(extractErrorMessage(signInErrors, ["identifier"]));
    }
  };

  const handleSubmit = async () => {
    setError("");
    const { error: signUpError } = await signUp.password({ emailAddress: email, password });
    if (signUpError) {
      setError(extractErrorMessage(errors, ["emailAddress", "password"]));
      return;
    }
    const { error: codeError } = await signUp.verifications.sendEmailCode();
    if (codeError) {
      setError(extractErrorMessage(errors, ["emailAddress"]));
      return;
    }
    setStep("verify");
  };

  const handleVerify = async () => {
    setError("");
    const { error: verifyError } = await signUp.verifications.verifyEmailCode({ code });
    if (verifyError) {
      setError(extractErrorMessage(errors, ["code"]));
    }
    // No explicit success branch -- the useEffect above reacts once signUp.status becomes
    // "complete" and React re-renders with the updated resource.
  };

  if (step === "verify") {
    return (
      <AuthShell
        eyebrow="🚀 Get Started"
        title="Check your email"
        subtitle={`We sent a verification code to ${email}. Enter it below to finish creating your account.`}
      >
        <form action={handleVerify} className="flex flex-col gap-4">
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
            {busy ? "Verifying..." : "Verify & Create Account"}
          </button>
          <button
            type="button"
            onClick={() => signUp.verifications.sendEmailCode()}
            className="text-xs font-semibold text-accent-ink hover:underline"
          >
            Didn&apos;t get a code? Send another
          </button>
        </form>
      </AuthShell>
    );
  }

  return (
    <AuthShell
      eyebrow="🚀 Get Started"
      title="Create your account"
      subtitle="Sign up to start designing cloud architectures."
      footer={
        <>
          Already have an account?{" "}
          <Link href="/login" className="font-bold text-accent-ink hover:underline">
            Sign in
          </Link>
        </>
      }
    >
      <form action={handleSubmit} className="flex flex-col gap-4">
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
          <label htmlFor="password" className="block text-xs font-semibold uppercase tracking-wider text-ink-muted">
            Password
          </label>
          <input
            type="password"
            id="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            disabled={busy}
            autoComplete="new-password"
            minLength={8}
            className="mt-2 w-full rounded-2xl border border-line bg-white px-4 py-3 text-sm text-ink shadow-sm focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent disabled:opacity-50"
            required
          />
          <p className="mt-1.5 text-[11px] text-ink-faint">At least 8 characters.</p>
        </div>

        {error && <p className="text-xs font-medium text-danger">{error}</p>}

        {/* Clerk's bot-protection CAPTCHA widget -- required placeholder for custom (headless)
            sign-up flows. Without it, Clerk silently falls back to an invisible widget that
            blocks suspected bots with no way for a real user to prove otherwise, rather than
            rendering a real challenge -- see Clerk's bot-sign-up-protection docs. */}
        <div id="clerk-captcha" />

        <button
          type="submit"
          disabled={busy}
          className="mt-2 flex w-full items-center justify-center rounded-2xl bg-accent px-5 py-3 text-sm font-semibold text-white shadow-md transition-all hover:bg-accent-ink active:scale-[0.98] disabled:opacity-50"
        >
          {busy ? (
            <span className="flex items-center gap-2">
              <span className="h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent" />
              Creating account...
            </span>
          ) : (
            "Create Account"
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
