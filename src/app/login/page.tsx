"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { useSignIn } from "@clerk/nextjs";
import AuthShell from "@/app/components/AuthShell";

function globalErrorMessage(errors: { global: { longMessage?: string; message: string }[] | null }): string {
  const first = errors.global?.[0];
  return first?.longMessage || first?.message || "Something went wrong. Please try again.";
}

// Headless (not Clerk's prebuilt <SignIn>) so this reads as part of the same product as every
// other screen in the app -- see AuthShell's own comment. "Forgot password?" isn't a separate
// page here: Clerk's reset flow is code-based (email a code, verify it, set a new password), not
// link-based like the old system, so it's a natural fit as three extra steps of this same form
// rather than two more route files.
type Mode = "signin" | "forgot-request" | "forgot-verify" | "forgot-reset";

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

  const finalizeAndGo = async () => {
    await signIn.finalize({
      navigate: () => {
        router.push(searchParams.get("next") || "/dashboard");
      },
    });
  };

  const handleSignIn = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    const { error: signInError } = await signIn.password({ emailAddress: email, password });
    if (signInError) {
      setError(globalErrorMessage(errors) || "Incorrect email or password.");
      return;
    }
    if (signIn.status === "complete") {
      await finalizeAndGo();
    } else {
      setError("We couldn't sign you in. Please try again.");
    }
  };

  const handleForgotRequest = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    const { error: createError } = await signIn.create({ identifier: email });
    if (createError) {
      setError(globalErrorMessage(errors) || "We couldn't find an account with that email.");
      return;
    }
    const { error: sendError } = await signIn.resetPasswordEmailCode.sendCode();
    if (sendError) {
      setError(globalErrorMessage(errors) || "We couldn't send a reset code. Please try again.");
      return;
    }
    setMode("forgot-verify");
  };

  const handleForgotVerify = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    const { error: verifyError } = await signIn.resetPasswordEmailCode.verifyCode({ code });
    if (verifyError) {
      setError(globalErrorMessage(errors) || "That code isn't right. Please check and try again.");
      return;
    }
    setMode("forgot-reset");
  };

  const handleForgotReset = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    const { error: submitError } = await signIn.resetPasswordEmailCode.submitPassword({
      password: newPassword,
      signOutOfOtherSessions: true,
    });
    if (submitError) {
      setError(globalErrorMessage(errors) || "We couldn't update your password. Please try again.");
      return;
    }
    if (signIn.status === "complete") {
      await finalizeAndGo();
    }
  };

  const startOver = () => {
    signIn.reset();
    setMode("signin");
    setCode("");
    setNewPassword("");
    setError("");
  };

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
        <form onSubmit={handleForgotRequest} className="flex flex-col gap-4">
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
        <form onSubmit={handleForgotVerify} className="flex flex-col gap-4">
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
        <form onSubmit={handleForgotReset} className="flex flex-col gap-4">
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
      <form onSubmit={handleSignIn} className="flex flex-col gap-4">
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
