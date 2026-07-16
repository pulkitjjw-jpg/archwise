import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import GoogleAuthButton from "./GoogleAuthButton";

describe("GoogleAuthButton", () => {
  it("renders a 'Continue with Google' button", () => {
    render(<GoogleAuthButton onClick={() => {}} />);
    expect(screen.getByRole("button", { name: /continue with google/i })).toBeInTheDocument();
  });

  it("calls onClick when clicked", async () => {
    const onClick = vi.fn();
    render(<GoogleAuthButton onClick={onClick} />);
    await userEvent.click(screen.getByRole("button", { name: /continue with google/i }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("disables the button and does not fire onClick when disabled is true", async () => {
    const onClick = vi.fn();
    render(<GoogleAuthButton onClick={onClick} disabled />);
    const button = screen.getByRole("button", { name: /continue with google/i });
    expect(button).toBeDisabled();
    await userEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });
});
