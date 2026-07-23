import { describe, expect, it } from "vitest";
import { chunkStoryText } from "./text-chunking";

describe("chunkStoryText", () => {
  it("splits on real blank-line paragraph breaks when present", () => {
    const text = "First paragraph here.\n\nSecond paragraph here.\n\nThird paragraph here.";
    expect(chunkStoryText(text)).toEqual(["First paragraph here.", "Second paragraph here.", "Third paragraph here."]);
  });

  it("never drops any text -- the joined output contains every original word", () => {
    const text =
      "A user submits a request through the Client App. The Application Load Balancer routes it to the API Container Service. " +
      "The service validates the request and queries Amazon Aurora PostgreSQL for the account. " +
      "Once validated, a message is published to the Notification Service, which sends an SMS to the user. " +
      "Finally, the response is returned to the user through the same load balancer.";
    const chunks = chunkStoryText(text);
    const rejoined = chunks.join(" ").replace(/\s+/g, " ").trim();
    const original = text.replace(/\s+/g, " ").trim();
    expect(rejoined).toBe(original);
  });

  it("falls back to sentence grouping when there are no blank lines at all", () => {
    const text =
      "A user submits a request through the Client App. The Application Load Balancer routes it to the API Container Service. " +
      "The service validates the request and queries Amazon Aurora PostgreSQL for the account. " +
      "Once validated, a message is published to the Notification Service, which sends an SMS to the user. " +
      "Finally, the response is returned to the user through the same load balancer.";
    const chunks = chunkStoryText(text);
    // A real single-paragraph LLM response (the actual bug report) must produce MORE than one
    // chunk -- this is the exact regression the fallback exists to fix.
    expect(chunks.length).toBeGreaterThan(1);
  });

  it("keeps a single short sentence as one chunk, no fallback needed", () => {
    expect(chunkStoryText("A single short sentence.")).toEqual(["A single short sentence."]);
  });

  it("returns an empty array for empty/whitespace-only input", () => {
    expect(chunkStoryText("")).toEqual([]);
    expect(chunkStoryText("   \n\n  ")).toEqual([]);
  });

  it("does not split on a decimal number or abbreviation followed by a lowercase word", () => {
    // "v1.2 supports..." should NOT be treated as a sentence boundary since the character after
    // the period is a digit, not a capital letter starting a new sentence.
    const text = "The API is versioned as v1.2 supports backward compatibility for older clients.";
    expect(chunkStoryText(text)).toEqual([text]);
  });
});
