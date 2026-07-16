"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { useClerk, useSignIn, useSignUp } from "@clerk/nextjs";
import AuthShell from "@/app/components/AuthShell";

type NavigateArgs = { decorateUrl: (path: string) => string };

// The shared landing page for every signIn.sso() redirect back into this app -- Google OAuth
// (see handleGoogleAuth in login/signup) and Enterprise SSO/SAML (see handleEnterpriseSSO in the
// same two files) both redirect here, since neither distinguishes "sign in" from "sign up" up
// front -- Clerk always starts the redirect as a sign-in attempt, and this page's job is to
// figure out, from the resulting signIn/signUp resource state, whether that's a returning user
// (finalize the sign-in), a brand-new one (transfer into a real sign-up and finalize that), or an
// account that already has an active session in this browser tab (e.g. the user picked the same
// account in a second tab). This logic operates entirely on signIn/signUp resource STATE
// (isTransferable, status, existingSession), never branching on which strategy produced that
// state, so it works identically for both -- no enterprise_sso-specific branch needed here.
export default function SsoCallbackPage() {
  const clerk = useClerk();
  const { signIn } = useSignIn();
  const { signUp } = useSignUp();
  const router = useRouter();
  const hasRun = useRef(false);
  const [error, setError] = useState("");

  // Same staleness workaround as login/page.tsx and signup/page.tsx: reading signIn.status or
  // signUp.status synchronously right after an await on this SDK's Signal-based resources can
  // return a stale snapshot even though the underlying call already resolved (confirmed live
  // during this migration). Refs + a short poll give the resource a moment to actually update
  // before branching on its status.
  const signInRef = useRef(signIn);
  const signUpRef = useRef(signUp);
  useEffect(() => {
    signInRef.current = signIn;
  }, [signIn]);
  useEffect(() => {
    signUpRef.current = signUp;
  }, [signUp]);

  const waitForSignInUpdate = async (predicate: (s: typeof signIn) => boolean) => {
    for (let i = 0; i < 20; i++) {
      if (predicate(signInRef.current)) return signInRef.current;
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    return signInRef.current;
  };

  const waitForSignUpUpdate = async (predicate: (s: typeof signUp) => boolean) => {
    for (let i = 0; i < 20; i++) {
      if (predicate(signUpRef.current)) return signUpRef.current;
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    return signUpRef.current;
  };

  useEffect(() => {
    if (!clerk.loaded || hasRun.current) return;
    hasRun.current = true;

    const navigateToDashboard = ({ decorateUrl }: NavigateArgs) => {
      const url = decorateUrl("/dashboard");
      if (url.startsWith("http")) {
        window.location.href = url;
      } else {
        router.push(url);
      }
    };

    // Diagnostic only -- prefixed so it's easy to filter for in devtools. Remove once both the
    // Google OAuth and Enterprise SSO flows have been confirmed working end-to-end against a real
    // account; left in for now because these branches can only be exercised with real Google/IdP
    // credentials, not the +clerk_test@ convention used everywhere else in this app's automated
    // testing.
    const log = (...args: unknown[]) => console.log("[sso-callback]", ...args);

    // Bounds the "Finishing sign-in..." spinner -- without this, any unhandled state (or a
    // promise that never settles, e.g. waiting on a captcha widget that never renders) leaves
    // the user stuck indefinitely with no feedback at all.
    const giveUpTimer = setTimeout(() => {
      log("timed out after 15s without finalizing. signIn:", signInRef.current, "signUp:", signUpRef.current);
      setError("This is taking longer than expected. Please try again.");
    }, 15000);

    (async () => {
      log("start. signIn.status:", signInRef.current.status, "signUp.status:", signUpRef.current.status);

      if (signInRef.current.status === "complete") {
        log("signIn already complete, finalizing");
        clearTimeout(giveUpTimer);
        await signInRef.current.finalize({ navigate: navigateToDashboard });
        return;
      }

      // No matching Clerk account for this Google identity yet -- convert the sign-in attempt
      // into a real sign-up.
      if (signUpRef.current.isTransferable) {
        log("signUp.isTransferable -- creating signIn with transfer:true");
        await signInRef.current.create({ transfer: true });
        const afterTransfer = await waitForSignInUpdate((s) => s.status !== "needs_identifier");
        log("after signIn transfer, status:", afterTransfer.status);
        if (afterTransfer.status === "complete") {
          clearTimeout(giveUpTimer);
          await afterTransfer.finalize({ navigate: navigateToDashboard });
          return;
        }
      }

      // The common case for a brand-new Google user: no signUp.sso() was ever called (this app
      // only ever calls signIn.sso(), from both login and signup), so signIn itself comes back
      // flagged transferable into a fresh sign-up.
      if (signInRef.current.isTransferable) {
        log("signIn.isTransferable -- creating signUp with transfer:true");
        await signUpRef.current.create({ transfer: true });
        const afterTransfer = await waitForSignUpUpdate((s) => s.status !== "missing_requirements");
        log("after signUp transfer, status:", afterTransfer.status);
      }

      if (signUpRef.current.status === "complete") {
        log("signUp complete, finalizing");
        clearTimeout(giveUpTimer);
        await signUpRef.current.finalize({ navigate: navigateToDashboard });
        return;
      }

      const sessionId = signInRef.current.existingSession?.sessionId || signUpRef.current.existingSession?.sessionId;
      if (sessionId) {
        log("existingSession found, activating", sessionId);
        clearTimeout(giveUpTimer);
        await clerk.setActive({ session: sessionId, navigate: navigateToDashboard });
        return;
      }

      log("no branch matched. Final signIn:", signInRef.current, "signUp:", signUpRef.current);
      clearTimeout(giveUpTimer);
      setError("We couldn't finish signing you in. Please try again.");
    })();

    return () => clearTimeout(giveUpTimer);
    // clerk.loaded is a plain mutable property, not itself reactive -- signIn and signUp ARE the
    // reactive Signal-based resources (same as login/signup's own effects), and are what actually
    // change identity once Clerk finishes processing the OAuth redirect. Depending on only
    // [clerk, router] (both referentially stable) meant this effect ran exactly once, on mount,
    // almost always before Clerk had finished loading -- saw clerk.loaded === false, returned
    // immediately, and never ran again, since neither dependency ever changes. Confirmed live:
    // zero console output at all, matching a guard that fired once and gave up permanently.
  }, [clerk, signIn, signUp, router]);

  return (
    <AuthShell
      eyebrow="🔑 Sign In"
      title="Finishing sign-in..."
      subtitle="Just a moment while we confirm your account."
    >
      {/* Turnstile can require this even mid-transfer (a sign-in transferred into a sign-up hits
          the same bot-protection check as a normal sign-up) -- see signup/page.tsx's identical
          placeholder and comment. */}
      <div id="clerk-captcha" />
      {error ? (
        <p className="text-sm font-medium text-danger">
          {error}{" "}
          <a href="/login" className="font-bold text-accent-ink hover:underline">
            Back to sign in
          </a>
        </p>
      ) : (
        <div className="flex items-center justify-center py-4">
          <span className="h-6 w-6 animate-spin rounded-full border-2 border-accent border-t-transparent" />
        </div>
      )}
    </AuthShell>
  );
}
