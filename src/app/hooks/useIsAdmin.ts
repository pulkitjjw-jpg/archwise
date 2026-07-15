"use client";

import { useAuth } from "@clerk/nextjs";
import { useEffect, useState } from "react";

// isAdmin is app-specific state Clerk has no concept of -- it lives in our own DB, keyed by
// clerk_user_id (see backend/app/models.py's User model), not in Clerk's user object. This is
// the one thing every admin page still needs to ask our own backend for, via the one route kept
// in app/routers/auth.py (GET /auth/me) after the rest of the old auth system was removed.
export function useIsAdmin(): { isAdmin: boolean | null; loading: boolean } {
  const { isLoaded, isSignedIn } = useAuth();
  const [isAdmin, setIsAdmin] = useState<boolean | null>(null);

  useEffect(() => {
    if (!isLoaded) return;
    if (!isSignedIn) {
      setIsAdmin(false);
      return;
    }
    fetch("/api/auth/me")
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => setIsAdmin(Boolean(data?.user?.isAdmin)))
      .catch(() => setIsAdmin(false));
  }, [isLoaded, isSignedIn]);

  return { isAdmin, loading: isAdmin === null };
}
