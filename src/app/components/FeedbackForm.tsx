"use client";

import { useState } from "react";
import Link from "next/link";
import { useUser } from "@clerk/nextjs";

const CATEGORIES = [
  { value: "", label: "General" },
  { value: "bug", label: "Something's broken" },
  { value: "feature", label: "Feature request" },
  { value: "other", label: "Other" },
];

export default function FeedbackForm() {
  const { isLoaded, isSignedIn } = useUser();
  const [message, setMessage] = useState("");
  const [category, setCategory] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setError("");
    try {
      const res = await fetch("/api/feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message, category: category || undefined }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || data.detail || "Failed to submit feedback");
      setSuccess(true);
      setMessage("");
      setCategory("");
    } catch (err: any) {
      setError(err.message || "Failed to submit feedback.");
    } finally {
      setSubmitting(false);
    }
  };

  if (!isLoaded) {
    return null;
  }

  if (!isSignedIn) {
    return (
      <div className="rounded-2xl border border-line bg-white p-5 text-sm text-ink-muted">
        <Link href="/login" className="font-semibold text-accent-ink hover:underline">
          Sign in
        </Link>{" "}
        to leave feedback — every message goes straight to the person building this.
      </div>
    );
  }

  if (success) {
    return (
      <div className="rounded-2xl border border-success/25 bg-success-soft p-5 text-sm font-medium text-success">
        Thanks — your feedback was submitted.
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-3 rounded-2xl border border-line bg-white p-5">
      <label className="flex flex-col gap-1.5">
        <span className="text-xs font-semibold text-ink-muted">Category</span>
        <select
          value={category}
          onChange={(e) => setCategory(e.target.value)}
          disabled={submitting}
          className="w-full rounded-xl border border-line bg-white px-3 py-2 text-sm text-ink shadow-sm focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent disabled:opacity-50"
        >
          {CATEGORIES.map((c) => (
            <option key={c.value} value={c.value}>
              {c.label}
            </option>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-1.5">
        <span className="text-xs font-semibold text-ink-muted">Your feedback</span>
        <textarea
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          disabled={submitting}
          required
          minLength={1}
          maxLength={5000}
          rows={5}
          placeholder="What's working, what isn't, what you wish it did..."
          className="w-full rounded-xl border border-line bg-white px-3 py-2.5 text-sm text-ink shadow-sm focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent disabled:opacity-50"
        />
      </label>
      {error && (
        <p role="alert" className="text-xs font-medium text-danger">
          {error}
        </p>
      )}
      <button
        type="submit"
        disabled={submitting || message.trim().length === 0}
        className="flex items-center justify-center rounded-2xl bg-accent px-5 py-2.5 text-sm font-semibold text-white shadow-md transition-all hover:bg-accent-ink active:scale-[0.98] disabled:opacity-50"
      >
        {submitting ? "Sending..." : "Send feedback"}
      </button>
    </form>
  );
}
