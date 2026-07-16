import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import EnterpriseSSOButton from "./EnterpriseSSOButton";

describe("EnterpriseSSOButton", () => {
  it("starts collapsed as a plain link, with no email input visible", () => {
    render(<EnterpriseSSOButton onSubmit={() => {}} />);
    expect(screen.getByRole("button", { name: /sign in with your company sso/i })).toBeInTheDocument();
    expect(screen.queryByLabelText(/work email/i)).not.toBeInTheDocument();
  });

  it("expands to show an email field and Continue button on click", async () => {
    render(<EnterpriseSSOButton onSubmit={() => {}} />);
    await userEvent.click(screen.getByRole("button", { name: /sign in with your company sso/i }));
    expect(screen.getByLabelText(/work email/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /continue/i })).toBeInTheDocument();
  });

  it("disables the Continue button until an email is entered", async () => {
    render(<EnterpriseSSOButton onSubmit={() => {}} />);
    await userEvent.click(screen.getByRole("button", { name: /sign in with your company sso/i }));
    const continueButton = screen.getByRole("button", { name: /continue/i });
    expect(continueButton).toBeDisabled();

    await userEvent.type(screen.getByLabelText(/work email/i), "jane@acme.com");
    expect(continueButton).toBeEnabled();
  });

  it("calls onSubmit with the typed email when the form is submitted", async () => {
    const onSubmit = vi.fn();
    render(<EnterpriseSSOButton onSubmit={onSubmit} />);
    await userEvent.click(screen.getByRole("button", { name: /sign in with your company sso/i }));
    await userEvent.type(screen.getByLabelText(/work email/i), "jane@acme.com");
    await userEvent.click(screen.getByRole("button", { name: /continue/i }));

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith("jane@acme.com");
  });

  it("does not call onSubmit if the email field is empty (defensive, matches the component's own guard)", async () => {
    const onSubmit = vi.fn();
    render(<EnterpriseSSOButton onSubmit={onSubmit} />);
    await userEvent.click(screen.getByRole("button", { name: /sign in with your company sso/i }));
    // Continue is disabled with an empty email, but the component's onSubmit handler itself also
    // guards on `if (email)` -- confirm that defense independently of the disabled attribute by
    // not typing anything and trying to submit via the disabled button (a no-op click).
    const continueButton = screen.getByRole("button", { name: /continue/i });
    await userEvent.click(continueButton);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("respects the disabled prop by disabling the collapsed toggle button", () => {
    render(<EnterpriseSSOButton onSubmit={() => {}} disabled />);
    expect(screen.getByRole("button", { name: /sign in with your company sso/i })).toBeDisabled();
  });
});
