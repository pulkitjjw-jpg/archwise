"use client";

import { useRouter } from "next/navigation";
import { useEffect, type ReactNode } from "react";
import { useIsAdmin } from "@/app/hooks/useIsAdmin";

// A convenience redirect, not the security boundary -- the backend's require_admin dependency
// (backend/app/dependencies.py) is what actually protects every admin route's data; this just
// stops a non-admin from seeing the page shell flash before their data fetches 403. Wraps each
// admin page's existing default export rather than being threaded through its internal return
// statements, so adding this didn't require touching any of those pages' own render logic.
export default function AdminGuard({ children }: { children: ReactNode }) {
  const { isAdmin, loading } = useIsAdmin();
  const router = useRouter();

  useEffect(() => {
    if (!loading && !isAdmin) router.replace("/dashboard");
  }, [loading, isAdmin, router]);

  if (loading || !isAdmin) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-paper">
        <div className="h-6 w-6 animate-spin rounded-full border-2 border-accent border-t-transparent" />
      </main>
    );
  }

  return <>{children}</>;
}
