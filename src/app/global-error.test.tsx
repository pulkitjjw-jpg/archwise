import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import GlobalError from "./global-error";

// Same "Next.js calls this directly with error/reset" contract as error.test.tsx -- see that
// file's comment. This one additionally renders its own <html>/<body> (a hard Next.js
// requirement for the root error boundary, since it replaces the root layout when it fires), so
// rendering it via RTL nests a second <html> inside jsdom's document; that's an accepted
// oddity of testing this particular file in isolation, not a bug in the component.

describe("app/global-error.tsx (root error boundary)", () => {
  it("renders the fallback UI", () => {
    render(<GlobalError error={new Error("boom")} reset={() => {}} />);
    expect(screen.getByText(/something went badly wrong/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /reload/i })).toBeInTheDocument();
  });

  it("calls reset() when 'Reload' is clicked", async () => {
    const reset = vi.fn();
    render(<GlobalError error={new Error("boom")} reset={reset} />);
    await userEvent.click(screen.getByRole("button", { name: /reload/i }));
    expect(reset).toHaveBeenCalledTimes(1);
  });
});
