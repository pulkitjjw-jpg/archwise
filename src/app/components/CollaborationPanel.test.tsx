import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import CollaborationPanel from "./CollaborationPanel";

const PROJECT_ID = "proj-1";

function jsonResponse(body: unknown) {
  return Promise.resolve({
    ok: true,
    json: () => Promise.resolve(body),
  }) as unknown as Promise<Response>;
}

function mockFetchFor({
  currentUserId,
  ownerId,
  members,
  comments,
}: {
  currentUserId: string;
  ownerId: string;
  members: { id: string; userId: string; userEmail: string; role: string; invitedByUserId: string | null; createdAt: string }[];
  comments: { id: string; authorUserId: string | null; authorEmail: string | null; body: string; createdAt: string; updatedAt: string | null }[];
}) {
  return vi.fn((url: string) => {
    if (url === "/api/auth/me") return jsonResponse({ user: { id: currentUserId } });
    if (url === `/api/projects/${PROJECT_ID}`) return jsonResponse({ project: { userId: ownerId } });
    if (url === `/api/projects/${PROJECT_ID}/members`) return jsonResponse({ members });
    if (url === `/api/projects/${PROJECT_ID}/comments`) return jsonResponse({ comments });
    throw new Error(`Unexpected fetch: ${url}`);
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("CollaborationPanel", () => {
  it("shows the invite form and per-member Remove buttons for the project owner", async () => {
    const fetchMock = mockFetchFor({
      currentUserId: "user-owner",
      ownerId: "user-owner",
      members: [
        { id: "m1", userId: "user-2", userEmail: "teammate@acme.com", role: "editor", invitedByUserId: "user-owner", createdAt: "2026-01-01T00:00:00Z" },
      ],
      comments: [],
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<CollaborationPanel projectId={PROJECT_ID} />);

    await waitFor(() => expect(screen.getByText("teammate@acme.com")).toBeInTheDocument());

    expect(screen.getByPlaceholderText(/email address/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^invite$/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /remove/i })).toBeInTheDocument();
  });

  it("hides the invite form and Remove buttons for a non-owner member", async () => {
    const fetchMock = mockFetchFor({
      currentUserId: "user-2",
      ownerId: "user-owner",
      members: [
        { id: "m1", userId: "user-2", userEmail: "teammate@acme.com", role: "editor", invitedByUserId: "user-owner", createdAt: "2026-01-01T00:00:00Z" },
      ],
      comments: [],
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<CollaborationPanel projectId={PROJECT_ID} />);

    await waitFor(() => expect(screen.getByText("teammate@acme.com")).toBeInTheDocument());

    expect(screen.queryByPlaceholderText(/email address/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^invite$/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /remove/i })).not.toBeInTheDocument();
    // Non-owner copy is shown instead of the invite-oriented copy.
    expect(screen.getByText(/everyone with access to this project/i)).toBeInTheDocument();
  });

  it("lets a non-owner delete their own comment but not someone else's", async () => {
    const fetchMock = mockFetchFor({
      currentUserId: "user-2",
      ownerId: "user-owner",
      members: [],
      comments: [
        { id: "c1", authorUserId: "user-2", authorEmail: "me@acme.com", body: "my comment", createdAt: "2026-01-01T00:00:00Z", updatedAt: null },
        { id: "c2", authorUserId: "user-owner", authorEmail: "owner@acme.com", body: "owner comment", createdAt: "2026-01-01T00:00:00Z", updatedAt: null },
      ],
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<CollaborationPanel projectId={PROJECT_ID} />);

    await waitFor(() => expect(screen.getByText("my comment")).toBeInTheDocument());

    const deleteButtons = screen.getAllByRole("button", { name: /delete/i });
    // Only the non-owner's own comment ("my comment") is deletable -- one Delete button, not two.
    expect(deleteButtons).toHaveLength(1);
  });

  it("shows an empty-state message when there are no members yet", async () => {
    const fetchMock = mockFetchFor({
      currentUserId: "user-owner",
      ownerId: "user-owner",
      members: [],
      comments: [],
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<CollaborationPanel projectId={PROJECT_ID} />);

    await waitFor(() => expect(screen.getByText(/no one else has been invited yet/i)).toBeInTheDocument());
  });
});
