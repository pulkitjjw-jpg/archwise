"use client";

import { useCallback, useEffect, useState } from "react";

// A single "Team" tab covering both collaboration surfaces this schema unlocks: WHO has access
// (ProjectMembership) and in-app discussion about the project (ProjectComment). Kept as one
// combined panel rather than two separate tabs -- the workspace already has two top-level tabs
// (Requirements / Architecture Diagram, see WorkspaceTabs.tsx) and neither members nor comments
// are dense enough on their own to earn a whole tab slot yet. Deliberately simple: a real
// product's collaboration MVP, not a fully-featured team-management or chat UI.

type Member = {
  id: string;
  userId: string;
  userEmail: string;
  role: string;
  invitedByUserId: string | null;
  createdAt: string;
};

type Comment = {
  id: string;
  authorUserId: string | null;
  authorEmail: string | null;
  body: string;
  createdAt: string;
  updatedAt: string | null;
};

interface CollaborationPanelProps {
  projectId: string;
}

function formatDateTime(value: string) {
  // Same explicit-locale reasoning as ChatArea.tsx's timestamp formatting -- an unspecified
  // locale can resolve differently between SSR and the browser and cause a hydration mismatch.
  return new Date(value).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default function CollaborationPanel({ projectId }: CollaborationPanelProps) {
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);
  const [ownerId, setOwnerId] = useState<string | null>(null);
  const [members, setMembers] = useState<Member[]>([]);
  const [comments, setComments] = useState<Comment[]>([]);
  const [loading, setLoading] = useState(true);

  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<"editor" | "viewer">("editor");
  const [inviteError, setInviteError] = useState<string | null>(null);
  const [inviting, setInviting] = useState(false);

  const [commentBody, setCommentBody] = useState("");
  const [commentError, setCommentError] = useState<string | null>(null);
  const [posting, setPosting] = useState(false);

  const isOwner = Boolean(currentUserId && ownerId && currentUserId === ownerId);

  const loadAll = useCallback(async () => {
    try {
      const [meRes, projectRes, membersRes, commentsRes] = await Promise.all([
        fetch("/api/auth/me"),
        fetch(`/api/projects/${projectId}`),
        fetch(`/api/projects/${projectId}/members`),
        fetch(`/api/projects/${projectId}/comments`),
      ]);

      if (meRes.ok) {
        const { user } = await meRes.json();
        setCurrentUserId(user?.id ?? null);
      }
      if (projectRes.ok) {
        const { project } = await projectRes.json();
        setOwnerId(project?.userId ?? null);
      }
      if (membersRes.ok) {
        const { members: fetchedMembers } = await membersRes.json();
        setMembers(fetchedMembers || []);
      }
      if (commentsRes.ok) {
        const { comments: fetchedComments } = await commentsRes.json();
        setComments(fetchedComments || []);
      }
    } catch (err) {
      console.error("Failed to load team/comments data:", err);
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    loadAll();
  }, [loadAll]);

  const handleInvite = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!inviteEmail.trim() || inviting) return;

    setInviting(true);
    setInviteError(null);
    try {
      const res = await fetch(`/api/projects/${projectId}/members`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: inviteEmail.trim(), role: inviteRole }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || "Failed to invite that person");
      }
      setMembers((prev) => [...prev, data.member]);
      setInviteEmail("");
    } catch (err) {
      setInviteError(err instanceof Error ? err.message : "Failed to invite that person");
    } finally {
      setInviting(false);
    }
  };

  const handleRevoke = async (membershipId: string) => {
    try {
      const res = await fetch(`/api/projects/${projectId}/members/${membershipId}`, { method: "DELETE" });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Failed to remove that member");
      }
      setMembers((prev) => prev.filter((m) => m.id !== membershipId));
    } catch (err) {
      console.error("Failed to revoke membership:", err);
    }
  };

  const handlePostComment = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!commentBody.trim() || posting) return;

    setPosting(true);
    setCommentError(null);
    try {
      const res = await fetch(`/api/projects/${projectId}/comments`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body: commentBody.trim() }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || "Failed to post that comment");
      }
      setComments((prev) => [...prev, data.comment]);
      setCommentBody("");
    } catch (err) {
      setCommentError(err instanceof Error ? err.message : "Failed to post that comment");
    } finally {
      setPosting(false);
    }
  };

  const handleDeleteComment = async (commentId: string) => {
    try {
      const res = await fetch(`/api/projects/${projectId}/comments/${commentId}`, { method: "DELETE" });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Failed to delete that comment");
      }
      setComments((prev) => prev.filter((c) => c.id !== commentId));
    } catch (err) {
      console.error("Failed to delete comment:", err);
    }
  };

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center p-8 text-ink-muted">
        <div className="h-6 w-6 animate-spin rounded-full border-4 border-accent border-t-transparent" />
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto p-6 space-y-8">
      {/* Members */}
      <section>
        <h3 className="text-sm font-bold uppercase tracking-wider text-ink-muted">Team</h3>
        <p className="mt-1 text-xs text-ink-faint">
          {isOwner
            ? "Invite people to view or edit this project. They need an account on this app already."
            : "Everyone with access to this project."}
        </p>

        <div className="mt-4 space-y-2">
          {members.length === 0 && (
            <p className="text-sm text-ink-faint italic">No one else has been invited yet.</p>
          )}
          {members.map((m) => (
            <div
              key={m.id}
              className="flex items-center justify-between gap-3 rounded-xl border border-line bg-white/80 px-4 py-2.5"
            >
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold text-ink">{m.userEmail}</p>
                <p className="text-[10px] uppercase tracking-wider text-ink-faint">
                  {m.role} &middot; added {formatDateTime(m.createdAt)}
                </p>
              </div>
              {isOwner && (
                <button
                  type="button"
                  onClick={() => handleRevoke(m.id)}
                  className="shrink-0 rounded-full border border-danger/30 px-3 py-1 text-[11px] font-semibold text-danger transition hover:bg-danger/10"
                >
                  Remove
                </button>
              )}
            </div>
          ))}
        </div>

        {isOwner && (
          <form onSubmit={handleInvite} className="mt-4 flex flex-wrap items-center gap-2">
            <input
              type="email"
              placeholder="Email address"
              value={inviteEmail}
              onChange={(e) => setInviteEmail(e.target.value)}
              disabled={inviting}
              className="min-w-[200px] flex-1 rounded-xl border border-line bg-white px-3 py-2 text-sm text-ink shadow-sm focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent disabled:opacity-50"
            />
            <select
              value={inviteRole}
              onChange={(e) => setInviteRole(e.target.value as "editor" | "viewer")}
              disabled={inviting}
              className="rounded-xl border border-line bg-white px-3 py-2 text-sm text-ink shadow-sm focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent disabled:opacity-50"
            >
              <option value="editor">Editor</option>
              <option value="viewer">Viewer</option>
            </select>
            <button
              type="submit"
              disabled={!inviteEmail.trim() || inviting}
              className="rounded-xl bg-ink px-4 py-2 text-sm font-semibold text-white shadow-md transition-all hover:bg-ink/90 active:scale-95 disabled:opacity-50"
            >
              {inviting ? "Inviting..." : "Invite"}
            </button>
          </form>
        )}
        {inviteError && <p className="mt-2 text-xs font-semibold text-danger">{inviteError}</p>}
      </section>

      {/* Comments */}
      <section>
        <h3 className="text-sm font-bold uppercase tracking-wider text-ink-muted">Comments</h3>
        <p className="mt-1 text-xs text-ink-faint">Discuss this project with your team.</p>

        <div className="mt-4 space-y-2">
          {comments.length === 0 && <p className="text-sm text-ink-faint italic">No comments yet.</p>}
          {comments.map((c) => {
            const canDelete = isOwner || c.authorUserId === currentUserId;
            return (
              <div key={c.id} className="rounded-xl border border-line bg-white/80 px-4 py-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-xs font-semibold text-ink">
                      {c.authorEmail || "Former member"}{" "}
                      <span className="font-normal text-ink-faint">&middot; {formatDateTime(c.createdAt)}</span>
                    </p>
                    <p className="mt-1 whitespace-pre-wrap text-sm text-ink">{c.body}</p>
                  </div>
                  {canDelete && (
                    <button
                      type="button"
                      onClick={() => handleDeleteComment(c.id)}
                      className="shrink-0 text-[11px] font-semibold text-ink-faint transition hover:text-danger"
                    >
                      Delete
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        <form onSubmit={handlePostComment} className="mt-4 flex flex-col gap-2">
          <textarea
            placeholder="Write a comment..."
            value={commentBody}
            onChange={(e) => setCommentBody(e.target.value)}
            disabled={posting}
            rows={2}
            className="w-full resize-none rounded-xl border border-line bg-white px-3 py-2 text-sm text-ink shadow-sm focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent disabled:opacity-50"
          />
          <div className="flex items-center justify-between">
            {commentError && <p className="text-xs font-semibold text-danger">{commentError}</p>}
            <button
              type="submit"
              disabled={!commentBody.trim() || posting}
              className="ml-auto rounded-xl bg-ink px-4 py-2 text-sm font-semibold text-white shadow-md transition-all hover:bg-ink/90 active:scale-95 disabled:opacity-50"
            >
              {posting ? "Posting..." : "Post Comment"}
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}
