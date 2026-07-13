"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ARCHITECTURE_TEMPLATES } from "@/lib/architecture-templates";

// Workstream U -- a plain markdown-image reference (![alt](path)) is the clearest, most reliable
// signal that an uploaded text file points at an embedded diagram this app can't actually read.
// Deliberately narrow (doesn't try to guess from prose like "see the diagram below") so the
// warning only fires when there's a real, unprocessed image reference to disclose.
const MARKDOWN_IMAGE_RE = /!\[[^\]]*\]\([^)]+\)/;

export default function IntakeForm() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [ideaText, setIdeaText] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  // Workstream T6 -- picking a template only pre-fills the idea text below with a realistic
  // starting paragraph for that kind of product; it never skips the brainstorm that follows.
  // Scale, budget, compliance, and team maturity are deliberately left out of every template so
  // the conversation still has real, non-trivial questions to ask regardless of which is picked.
  const [selectedTemplateId, setSelectedTemplateId] = useState<string | null>(null);
  const selectedTemplate = ARCHITECTURE_TEMPLATES.find((t) => t.id === selectedTemplateId) || null;

  const applyTemplate = (templateId: string | null) => {
    setSelectedTemplateId(templateId);
    const template = ARCHITECTURE_TEMPLATES.find((t) => t.id === templateId);
    setIdeaText(template ? template.ideaText : "");
  };

  // Workstream T5 -- lets a team modernizing an existing app (not starting from scratch) say so
  // up front. The brainstorm then also asks about current stack/deployment/pain points, and once
  // a target architecture exists, a phased Migration Roadmap becomes available.
  const [hasExistingSystem, setHasExistingSystem] = useState(false);
  const [existingSystemText, setExistingSystemText] = useState("");

  // Workstream U -- uploading a text/markdown doc is an alternative (or supplement) to typing the
  // existing-system description by hand. Read entirely client-side (FileReader), then fed into
  // the SAME existingSystemText field manual typing already uses -- no new backend endpoint, no
  // parallel intake path. Only the extracted TEXT is ever used; an embedded image/diagram
  // reference in the file is detected and disclosed, never silently dropped.
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploadedFileName, setUploadedFileName] = useState<string | null>(null);
  const [uploadHasImageRef, setUploadHasImageRef] = useState(false);
  const [uploadError, setUploadError] = useState("");

  const handleFileUpload = (file: File) => {
    setUploadError("");
    const nameLower = file.name.toLowerCase();
    const isTextLike = nameLower.endsWith(".txt") || nameLower.endsWith(".md") || file.type.startsWith("text/");
    if (!isTextLike) {
      setUploadError("Only plain text (.txt) or markdown (.md) files are supported right now -- upload a written description, not an image or diagram file directly.");
      return;
    }

    const reader = new FileReader();
    reader.onload = () => {
      const text = String(reader.result || "").trim();
      if (!text) {
        setUploadError("That file appears to be empty.");
        return;
      }
      setUploadedFileName(file.name);
      setUploadHasImageRef(MARKDOWN_IMAGE_RE.test(text));
      // Append rather than overwrite -- a user may have already typed some notes before
      // deciding to also attach a doc; neither should silently discard the other.
      setExistingSystemText((prev) => (prev.trim() ? `${prev.trim()}\n\n${text}` : text));
    };
    reader.onerror = () => setUploadError("Failed to read that file. Please try again.");
    reader.readAsText(file);
  };

  const handleFileInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) handleFileUpload(file);
    e.target.value = ""; // allow re-selecting the same file after removing it
  };

  const clearUploadedFile = () => {
    setUploadedFileName(null);
    setUploadHasImageRef(false);
    setUploadError("");
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !ideaText.trim()) {
      setError("Please fill in all fields.");
      return;
    }

    setLoading(true);
    setError("");

    try {
      const response = await fetch("/api/projects", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ name, ideaText, hasExistingSystem, existingSystemText }),
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || "Failed to create project");
      }

      const { projectId } = await response.json();
      router.push(`/projects/${projectId}`);
    } catch (err: any) {
      setError(err.message || "An unexpected error occurred.");
      setLoading(false);
    }
  };

  return (
    <div className="rounded-[2rem] border border-white/70 bg-white/80 p-6 shadow-xl backdrop-blur-md sm:p-8">
      <span className="inline-flex items-center gap-1.5 rounded-full bg-accent-soft border border-accent/25 px-2.5 py-1 text-[10px] font-bold text-accent-ink uppercase tracking-wider">
        🧭 New Project
      </span>
      <h3 className="mt-3 text-2xl font-black tracking-tight text-ink">Start a New Architecture Project</h3>
      <p className="mt-2 text-sm text-ink-muted leading-relaxed">
        Enter a project name and a brief description of the product you want to build. We will brainstorm details together, then generate a fully-reasoned multi-cloud architecture.
      </p>

      {/* Process strip -- sets expectations for what happens after submit, since the next
          screen (chat) isn't self-explanatory to a first-time user. */}
      <div className="mt-5 grid grid-cols-3 gap-3 rounded-2xl border border-line bg-paper/70 p-3.5">
        {[
          { step: "1", label: "Describe" },
          { step: "2", label: "Brainstorm" },
          { step: "3", label: "Get Architecture" },
        ].map((s) => (
          <div key={s.step} className="flex items-center gap-2">
            <span className="flex h-5 w-5 flex-none items-center justify-center rounded-full bg-ink text-[10px] font-bold text-white">
              {s.step}
            </span>
            <span className="text-[11px] font-semibold text-ink-muted leading-tight">{s.label}</span>
          </div>
        ))}
      </div>

      <form onSubmit={handleSubmit} className="mt-6 space-y-4">
        <div>
          <label className="block text-xs font-semibold uppercase tracking-wider text-ink-muted">
            Start from a template? (optional)
          </label>
          <div className="mt-2 flex flex-wrap gap-1.5">
            <button
              type="button"
              onClick={() => applyTemplate(null)}
              disabled={loading}
              className={`rounded-full border px-3 py-1.5 text-xs font-semibold transition disabled:opacity-50 ${
                !selectedTemplateId
                  ? "border-ink bg-ink text-white"
                  : "border-line bg-white text-ink-muted hover:border-ink-faint"
              }`}
            >
              ✏️ Start from scratch
            </button>
            {ARCHITECTURE_TEMPLATES.map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => applyTemplate(t.id)}
                disabled={loading}
                title={t.tagline}
                className={`rounded-full border px-3 py-1.5 text-xs font-semibold transition disabled:opacity-50 ${
                  selectedTemplateId === t.id
                    ? "border-accent bg-accent text-white"
                    : "border-line bg-white text-ink-muted hover:border-ink-faint"
                }`}
              >
                {t.emoji} {t.label}
              </button>
            ))}
          </div>
          {selectedTemplate && (
            <p className="mt-2 text-[11px] text-ink-muted">
              {selectedTemplate.tagline}. Pre-filled the idea below as a starting point -- edit it freely, and we&apos;ll
              still ask about scale, budget, and compliance in the brainstorm next.
            </p>
          )}
        </div>

        <div>
          <label htmlFor="project-name" className="block text-xs font-semibold uppercase tracking-wider text-ink-muted">
            Project Name
          </label>
          <input
            type="text"
            id="project-name"
            placeholder={selectedTemplate ? selectedTemplate.namePlaceholder : "e.g. FinTech Payment Gateway, SaaS CRM"}
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={loading}
            // A short label, not a description -- the idea text field below (kept unlimited,
            // full context matters there) is where the actual detail belongs.
            maxLength={120}
            className="mt-2 w-full rounded-2xl border border-line bg-white px-4 py-3 text-sm text-ink shadow-sm focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent disabled:opacity-50"
            required
          />
        </div>

        <div>
          <label htmlFor="product-idea" className="block text-xs font-semibold uppercase tracking-wider text-ink-muted">
            Product Idea & Context
          </label>
          <textarea
            id="product-idea"
            rows={10}
            placeholder="Describe what your product does, who uses it, key requirements, expected traffic scale, etc. Paste as much as you have -- a full paragraph, an AI-generated brief, whatever you've already written."
            value={ideaText}
            onChange={(e) => setIdeaText(e.target.value)}
            disabled={loading}
            className="mt-2 w-full min-h-[220px] resize-y rounded-2xl border border-line bg-white px-4 py-3 text-sm text-ink shadow-sm focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent disabled:opacity-50"
            required
          />
        </div>

        <div className="rounded-2xl border border-line bg-paper/70 p-4">
          <label className="flex items-center gap-2 text-xs font-semibold text-ink">
            <input
              type="checkbox"
              checked={hasExistingSystem}
              onChange={(e) => setHasExistingSystem(e.target.checked)}
              disabled={loading}
              className="h-4 w-4 accent-accent"
            />
            I have an existing system (modernizing, not starting from scratch)
          </label>

          {hasExistingSystem && (
            <div className="mt-4 space-y-4">
              <div>
                <label
                  htmlFor="existing-system-text"
                  className="block text-[10px] font-bold uppercase tracking-wider text-ink-faint"
                >
                  Describe it, or upload a doc below
                </label>
                <textarea
                  id="existing-system-text"
                  rows={7}
                  placeholder="Tech stack, how it's deployed, and the main pain points (e.g. &quot;a monolithic PHP app on a single VM, no CI/CD, manual deploys, struggling to scale past 500 users&quot;). You can also leave this blank and we'll ask about it during the brainstorm."
                  value={existingSystemText}
                  onChange={(e) => setExistingSystemText(e.target.value)}
                  disabled={loading}
                  className="mt-1.5 w-full min-h-[150px] resize-y rounded-xl border border-line bg-white px-3.5 py-3 text-sm text-ink shadow-sm focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent disabled:opacity-50"
                />
              </div>

              <div className="border-t border-line pt-4">
                <span className="block text-[10px] font-bold uppercase tracking-wider text-ink-faint">
                  Or upload a document (optional)
                </span>
                <p className="mt-1 text-[11px] text-ink-muted leading-relaxed">
                  Plain text (.txt) or markdown (.md) only for now. Its text is appended to the description above.
                </p>

                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".txt,.md,text/plain,text/markdown"
                  onChange={handleFileInputChange}
                  disabled={loading}
                  className="hidden"
                />

                {!uploadedFileName ? (
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    disabled={loading}
                    className="mt-2.5 flex w-full items-center justify-center gap-2 rounded-xl border border-dashed border-line-strong bg-white px-3.5 py-3 text-xs font-semibold text-ink-muted transition hover:border-accent hover:text-accent-ink disabled:opacity-50"
                  >
                    📎 Choose a .txt or .md file
                  </button>
                ) : (
                  <div className="mt-2.5 flex items-center justify-between gap-2 rounded-xl border border-success/25 bg-success-soft/50 px-3.5 py-2.5 text-xs text-success">
                    <span className="flex min-w-0 items-center gap-1.5 font-semibold">
                      ✅ <span className="truncate">{uploadedFileName}</span> added to the description
                    </span>
                    <button
                      type="button"
                      onClick={clearUploadedFile}
                      className="flex-none font-bold text-ink-muted transition hover:text-ink"
                    >
                      Remove
                    </button>
                  </div>
                )}

                {uploadError && <p className="mt-2 text-[11px] font-medium text-danger">{uploadError}</p>}

                {/* Discloses rather than silently drops an embedded image/diagram reference --
                    this app doesn't do image/diagram understanding, so pretending the diagram was
                    "read" would be actively misleading. */}
                {uploadHasImageRef && (
                  <div className="mt-2.5 flex items-start gap-2 rounded-xl border border-warning/25 bg-warning-soft/50 px-3.5 py-2.5 text-[11px] text-warning">
                    <span className="mt-0.5">⚠️</span>
                    <span className="leading-relaxed">
                      This file references an embedded image or diagram. Only the <strong>text</strong> content was
                      extracted and will be used -- diagram/image understanding isn&apos;t supported yet, so describe
                      any important visual details in words too.
                    </span>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

        {error && <p className="text-xs font-medium text-danger">{error}</p>}

        <button
          type="submit"
          disabled={loading}
          className="flex w-full items-center justify-center rounded-2xl bg-accent px-5 py-3 text-sm font-semibold text-white shadow-md transition-all hover:bg-accent-ink active:scale-[0.98] disabled:opacity-50"
        >
          {loading ? (
            <span className="flex items-center gap-2">
              <span className="h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent" />
              Initializing Workspace...
            </span>
          ) : (
            "Launch Brainstorm Workspace"
          )}
        </button>
      </form>
    </div>
  );
}
