import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import ArchitectureWorkspaceErrorBoundary from "./ArchitectureWorkspaceErrorBoundary";

function Bomb({ shouldThrow }: { shouldThrow: boolean }) {
  if (shouldThrow) throw new Error("kaboom");
  return <div>workspace content</div>;
}

describe("ArchitectureWorkspaceErrorBoundary", () => {
  // React logs a (correct, expected) console.error for every caught render error -- silence it
  // for these tests so intentional test failures don't get lost in expected noise, and restore
  // afterward so a real regression elsewhere still surfaces normally.
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  it("renders children normally when nothing throws", () => {
    render(
      <ArchitectureWorkspaceErrorBoundary>
        <Bomb shouldThrow={false} />
      </ArchitectureWorkspaceErrorBoundary>
    );
    expect(screen.getByText("workspace content")).toBeInTheDocument();
  });

  it("catches a render error from a child and shows the fallback UI instead of crashing", () => {
    render(
      <ArchitectureWorkspaceErrorBoundary>
        <Bomb shouldThrow={true} />
      </ArchitectureWorkspaceErrorBoundary>
    );
    expect(screen.getByText(/the architecture workspace hit a problem/i)).toBeInTheDocument();
    expect(screen.queryByText("workspace content")).not.toBeInTheDocument();
  });

  it("resets to hasError: false and re-renders children when 'Try again' is clicked", async () => {
    // Rerender with shouldThrow flipped to false after clicking Try again -- mirrors the real
    // scenario where the underlying cause (e.g. bad data) is expected to have cleared before the
    // user retries.
    const { rerender } = render(
      <ArchitectureWorkspaceErrorBoundary>
        <Bomb shouldThrow={true} />
      </ArchitectureWorkspaceErrorBoundary>
    );
    expect(screen.getByText(/the architecture workspace hit a problem/i)).toBeInTheDocument();

    rerender(
      <ArchitectureWorkspaceErrorBoundary>
        <Bomb shouldThrow={false} />
      </ArchitectureWorkspaceErrorBoundary>
    );
    await userEvent.click(screen.getByRole("button", { name: /try again/i }));

    expect(screen.getByText("workspace content")).toBeInTheDocument();
  });
});
