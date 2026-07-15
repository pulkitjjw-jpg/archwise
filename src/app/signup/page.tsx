"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import AuthShell from "@/app/components/AuthShell";
import { useAuth } from "@/app/contexts/AuthContext";

export default function SignupPage() {
  const router = useRouter();
  const { register } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (password.length < 8) {
      setError("Password must be at least 8 characters.");
      return;
    }
    setLoading(true);
    setError("");
    try {
      await register(email, password);
      router.push("/dashboard");
    } catch (err: any) {
      setError(err.message || "Failed to create an account.");
      setLoading(false);
    }
  };

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
            disabled={loading}
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
            disabled={loading}
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
          disabled={loading}
          className="mt-2 flex w-full items-center justify-center rounded-2xl bg-accent px-5 py-3 text-sm font-semibold text-white shadow-md transition-all hover:bg-accent-ink active:scale-[0.98] disabled:opacity-50"
        >
          {loading ? (
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
