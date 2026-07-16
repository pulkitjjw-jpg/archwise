import { describe, expect, it } from "vitest";
import { pollForUpdate } from "./poll";

describe("pollForUpdate", () => {
  it("resolves immediately when the predicate is already true, without sleeping", async () => {
    let reads = 0;
    const getCurrent = () => {
      reads += 1;
      return "complete";
    };
    const result = await pollForUpdate(getCurrent, (v) => v === "complete", { intervalMs: 1 });
    expect(result).toBe("complete");
    // Exactly one read -- proves the loop returned on the first iteration rather than sleeping
    // through the whole window.
    expect(reads).toBe(1);
  });

  it("keeps polling a mutable source until the predicate becomes true", async () => {
    const states = ["needs_identifier", "needs_identifier", "needs_client_trust", "complete"];
    let i = 0;
    const getCurrent = () => states[Math.min(i, states.length - 1)];
    const advance = () => {
      i += 1;
    };
    // Simulate the ref being updated by a real re-render between polls by advancing `i` on every
    // read via a wrapper -- mirrors how signInRef.current changes out from under the closure in
    // the real component.
    const wrappedGetCurrent = () => {
      const value = getCurrent();
      advance();
      return value;
    };
    const result = await pollForUpdate(wrappedGetCurrent, (v) => v === "complete", { intervalMs: 1 });
    expect(result).toBe("complete");
  });

  it("gives up after maxAttempts and returns the last observed value instead of hanging", async () => {
    const getCurrent = () => "needs_identifier";
    const result = await pollForUpdate(getCurrent, (v) => v === "complete", {
      maxAttempts: 3,
      intervalMs: 1,
    });
    // Never satisfied the predicate -- must still resolve (not reject, not hang) with whatever
    // the source last reported.
    expect(result).toBe("needs_identifier");
  });

  it("respects a custom maxAttempts, bounding the total number of reads", async () => {
    let reads = 0;
    const getCurrent = () => {
      reads += 1;
      return "pending";
    };
    await pollForUpdate(getCurrent, (v) => v === "complete", { maxAttempts: 5, intervalMs: 1 });
    // 5 reads inside the polling loop (one per attempt) + 1 final unconditional read on the way
    // out (mirrors the original inline implementation's `return signInRef.current` after the
    // loop -- a last-chance read in case the source changed during the final sleep). Bounded and
    // deterministic either way -- the real guarantee under test is that it does NOT keep growing
    // past maxAttempts+1 (i.e. it terminates rather than polling forever).
    expect(reads).toBe(6);
  });
});
