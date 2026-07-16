import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
// Imported as ErrorPage, NOT Error -- importing it as `Error` would shadow the global `Error`
// constructor used below (`new Error("boom")`) within this module's scope, silently passing the
// React component itself to `new`, not the JS error object it expects. (Confirmed live: doing so
// produces a confusing "Cannot read properties of null (reading 'useEffect')" failure that looks
// unrelated to the actual mistake.)
import ErrorPage from "./error";

// Next.js calls this component directly with `error`/`reset` when a Server or Client Component
// under this route segment throws during render -- it is not itself a React error boundary, so
// no <ErrorBoundary> wrapper is needed to exercise it; just render it with the same props Next.js
// would pass.

describe("app/error.tsx (route-segment error boundary)", () => {
  it("renders the fallback UI instead of the crashed tree", () => {
    render(<ErrorPage error={new Error("boom")} reset={() => {}} />);
    expect(screen.getByText(/we hit a snag/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /try again/i })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /back to home/i })).toBeInTheDocument();
  });

  it("calls reset() when 'Try again' is clicked", async () => {
    const reset = vi.fn();
    render(<ErrorPage error={new Error("boom")} reset={reset} />);
    await userEvent.click(screen.getByRole("button", { name: /try again/i }));
    expect(reset).toHaveBeenCalledTimes(1);
  });

  it("links back home", () => {
    render(<ErrorPage error={new Error("boom")} reset={() => {}} />);
    expect(screen.getByRole("link", { name: /back to home/i })).toHaveAttribute("href", "/");
  });
});
