// Shared implementation of the "wait for a Clerk Signal-based resource to update" pattern that
// previously existed as three near-identical, unexported closures: login/page.tsx's
// waitForSignInUpdate, and sso-callback/page.tsx's waitForSignInUpdate/waitForSignUpUpdate. Reads
// synchronously right after an `await signIn.password(...)`/`verifyEmailCode(...)` (etc.) are not
// reliable with this SDK version -- confirmed live that the closure can still read a stale
// snapshot even though the underlying API call already resolved. Polling a ref (not the async
// function's own closure-captured value) gives pending re-renders a chance to land before giving
// up. Always resolves -- never rejects, never hangs -- returning the last read value even if the
// predicate never became true within maxAttempts.
export async function pollForUpdate<T>(
  getCurrent: () => T,
  predicate: (value: T) => boolean,
  { maxAttempts = 20, intervalMs = 150 }: { maxAttempts?: number; intervalMs?: number } = {}
): Promise<T> {
  for (let i = 0; i < maxAttempts; i++) {
    const current = getCurrent();
    if (predicate(current)) return current;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return getCurrent();
}
