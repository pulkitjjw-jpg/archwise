"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useSignUp } from "@clerk/nextjs";
import AuthShell from "@/app/components/AuthShell";

function globalErrorMessage(errors: { global: { longMessage?: string; message: string }[] | null }): string {
  const first = errors.global?.[0];
  return first?.longMessage || first?.message || "Something went wrong. Please try again.";
}

export default function SignupPage() {
  const router = useRouter();
  const { signUp, errors, fetchStatus } = useSignUp();
  const busy = fetchStatus === "fetching";

  const [step, setStep] = useState<"details" | "verify">("details");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState("");

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    const { error: signUpError } = await signUp.password({ emailAddress: email, password });
    if (signUpError) {
      setError(globalErrorMessage(errors) || "Failed to create an account.");
      return;
    }
    const { error: codeError } = await signUp.verifications.sendEmailCode();
    if (codeError) {
      setError(globalErrorMessage(errors) || "We couldn't send a verification code. Please try again.");
      return;
    }
    setStep("verify");
  };

  const handleVerify = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    const { error: verifyError } = await signUp.verifications.verifyEmailCode({ code });
    if (verifyError) {
      setError(globalErrorMessage(errors) || "That code isn't right. Please check and try again.");
      return;
    }
    if (signUp.status === "complete") {
      await signUp.finalize({
        navigate: () => router.push("/dashboard"),
      });
    } else {
      setError("We couldn't finish creating your account. Please try again.");
    }
  };

  if (step === "verify") {
    return (
      <AuthShell
        eyebrow="🚀 Get Started"
        title="Check your email"
        subtitle={`We sent a verification code to ${email}. Enter it below to finish creating your account.`}
      >
        <form onSubmit={handleVerify} className="flex flex-col gap-4">
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
      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
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
    </AuthShell>
  );
}
