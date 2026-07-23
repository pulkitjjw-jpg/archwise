"use client";

import { useEffect, useState } from "react";
import InfoTooltip from "./InfoTooltip";
import SourceCitations, { type Citation } from "./SourceCitations";
import BudgetInput from "./BudgetInput";
import { FIELD_EXPLANATIONS } from "@/lib/field-explanations";
import { useStagedLoadingMessage } from "@/app/hooks/useStagedLoadingMessage";

const EXTRACTION_STAGES = [
  "Reading through the discovery conversation...",
  "Structuring functional capabilities...",
  "Weighing non-functional constraints...",
  "Almost done...",
];
const EXTRACTION_STAGE_INTERVAL_MS = 4000;

type RequirementsData = {
  functional: string[];
  nonFunctional: {
    expectedScale: string;
    readWritePattern: string;
    dataNature: string;
    latencySensitivity: string;
    budget: string;
    teamMaturity: string;
    compliance: string;
  };
  industryContext?: {
    industry: "fintech" | "healthtech" | "none";
    rationale: string;
    complianceAnswers: Array<{ question: string; answer: string }>;
    flags: Record<string, unknown>;
  };
  conversationSummary?: string | null;
  conversationSummarySources?: Citation[] | null;
};

const INDUSTRY_BADGE: Record<"fintech" | "healthtech", { label: string; emoji: string }> = {
  fintech: { label: "Fintech", emoji: "💳" },
  healthtech: { label: "Healthtech", emoji: "🏥" },
};

interface RequirementsPanelProps {
  projectId: string;
  isBrainstormComplete: boolean;
  onSaveComplete?: () => void;
  focusField?: string | null;
  clearFocusField?: () => void;
  onGoToArchitecture?: () => void;
}

export default function RequirementsPanel({
  projectId,
  isBrainstormComplete,
  onSaveComplete,
  focusField,
  clearFocusField,
  onGoToArchitecture,
}: RequirementsPanelProps) {
  const [requirements, setRequirements] = useState<RequirementsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [extracting, setExtracting] = useState(false);
  const extractionStage = useStagedLoadingMessage(extracting, EXTRACTION_STAGES, EXTRACTION_STAGE_INTERVAL_MS);
  const [editMode, setEditMode] = useState(false);
  const [error, setError] = useState("");

  // Conversation Summary -- cached server-side on the requirements row, so this only pays for a
  // real LLM call the first time a given requirements version is viewed.
  const [conversationSummary, setConversationSummary] = useState<string | null>(null);
  const [conversationSummarySources, setConversationSummarySources] = useState<Citation[]>([]);
  const [summaryLoading, setSummaryLoading] = useState(false);

  const loadConversationSummary = async () => {
    try {
      setSummaryLoading(true);
      const res = await fetch(`/api/projects/${projectId}/requirements/summary`, { method: "POST" });
      if (res.ok) {
        const data = await res.json();
        setConversationSummary(data.summary || null);
        setConversationSummarySources(data.sources || []);
      }
    } catch (err) {
      console.error("Failed to load conversation summary:", err);
    } finally {
      setSummaryLoading(false);
    }
  };

  useEffect(() => {
    if (!requirements) return;
    if (requirements.conversationSummary) {
      setConversationSummary(requirements.conversationSummary);
      setConversationSummarySources(requirements.conversationSummarySources || []);
      return;
    }
    loadConversationSummary();
  }, [requirements]);

  // Edit states
  const [editedFunctional, setEditedFunctional] = useState("");
  const [editedNFR, setEditedNFR] = useState({
    expectedScale: "",
    readWritePattern: "",
    dataNature: "",
    latencySensitivity: "",
    budget: "",
    teamMaturity: "",
    compliance: "",
  });

  // AI-suggested chip options per field -- fetched fresh on entering edit mode so they reflect
  // whatever's actually specified so far, not stale from a previous session. Each suggestion
  // carries a short "why" grounded in the actual project context, shown via an info tooltip.
  type Suggestion = { value: string; why: string; sources?: Citation[] };
  type FieldSuggestions = Partial<Record<keyof typeof editedNFR | "functional", Suggestion[]>>;
  const [fieldSuggestions, setFieldSuggestions] = useState<FieldSuggestions>({});
  const [suggestionsLoading, setSuggestionsLoading] = useState(false);
  // Previously this had no error path at all -- a failed/non-ok response just left
  // fieldSuggestions empty with nothing logged anywhere but the console, so the UI silently went
  // from "Generating suggestions..." to nothing, indistinguishable from "the AI genuinely had no
  // suggestions for this field."
  const [suggestionsError, setSuggestionsError] = useState("");

  const loadSuggestions = async (functional: string[], nonFunctional: typeof editedNFR) => {
    try {
      setSuggestionsLoading(true);
      setSuggestionsError("");
      const res = await fetch(`/api/projects/${projectId}/requirements/suggestions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ functional, nonFunctional }),
      });
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error || errData.detail || "Failed to generate suggestions.");
      }
      const data = await res.json();
      setFieldSuggestions(data.suggestions || {});
    } catch (err: any) {
      console.error("Failed to load requirement suggestions:", err);
      setSuggestionsError(err.message || "Failed to generate suggestions.");
    } finally {
      setSuggestionsLoading(false);
    }
  };

  const startEditing = () => {
    if (!requirements) return;
    setEditedFunctional(requirements.functional.join("\n"));
    // Spread onto the same all-empty-string shape editedNFR's own useState started with, not
    // requirements.nonFunctional directly -- a persisted record with a genuinely missing key
    // (confirmed live, despite the type below claiming every key is always a string) would
    // otherwise leave that one input as an uncontrolled `value={undefined}`, which React warns
    // about loudly even though it isn't the hard crash a bare `undefined` on read (see
    // renderNFRField above) is. The Partial<> cast is the honest type for real persisted data,
    // not the always-fully-populated type nonFunctional otherwise claims.
    setEditedNFR({
      expectedScale: "",
      readWritePattern: "",
      dataNature: "",
      latencySensitivity: "",
      budget: "",
      teamMaturity: "",
      compliance: "",
      ...(requirements.nonFunctional as Partial<typeof editedNFR>),
    });
    setEditMode(true);
    setFieldSuggestions({});
    loadSuggestions(requirements.functional, requirements.nonFunctional);
  };

  const applySuggestion = (fieldName: keyof typeof editedNFR, value: string) => {
    setEditedNFR((prev) => ({ ...prev, [fieldName]: value }));
  };

  const applyFunctionalSuggestion = (value: string) => {
    setEditedFunctional((prev) => (prev.trim() ? `${prev.replace(/\n+$/, "")}\n${value}` : value));
  };

  const handleExtract = async () => {
    try {
      setExtracting(true);
      setError("");
      const res = await fetch(`/api/projects/${projectId}/requirements`, {
        method: "POST",
      });
      if (!res.ok) {
        throw new Error("Failed to extract requirements");
      }
      const data = await res.json();
      setRequirements(data.requirements);
      if (onSaveComplete) onSaveComplete();
    } catch (err: any) {
      setError(err.message || "Extraction failed.");
    } finally {
      setExtracting(false);
    }
  };

  const loadRequirements = async () => {
    try {
      setLoading(true);
      const res = await fetch(`/api/projects/${projectId}/requirements`);
      if (res.ok) {
        const data = await res.json();
        if (data.requirements) {
          setRequirements(data.requirements);
        } else if (isBrainstormComplete) {
          // Auto-extract if brainstorm completed but no requirements exist yet
          await handleExtract();
        }
      }
    } catch (err) {
      console.error("Failed to load requirements:", err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadRequirements();
  }, [projectId, isBrainstormComplete]);

  // Auto-refresh when requirements change elsewhere (chat brainstorm/growth-trigger conclusion,
  // manual edits saved from a different tab instance, etc). `isBrainstormComplete` alone can't
  // catch this: it's a prop computed once server-side on page load and never changes on the
  // client afterward, so without this listener the Requirements tab only ever reflected fresh
  // data after a full page reload. Skipped while actively editing so a background update can't
  // silently blow away in-progress form edits -- shows the fallback banner instead in that case.
  const [hasStaleData, setHasStaleData] = useState(false);
  useEffect(() => {
    const handleUpdate = () => {
      if (editMode) {
        setHasStaleData(true);
        return;
      }
      loadRequirements();
    };
    window.addEventListener("requirementsUpdated", handleUpdate);
    return () => window.removeEventListener("requirementsUpdated", handleUpdate);
  }, [editMode]);

  const handleManualRefresh = async () => {
    setHasStaleData(false);
    // If mid-edit, discard the in-progress draft rather than refreshing underneath it -- the
    // draft (editedFunctional/editedNFR) has no way to reconcile with newly-fetched data, and
    // silently leaving edit mode active with a now-stale draft risks the next Save clobbering
    // the fresh data being pulled in here.
    if (editMode) setEditMode(false);
    await loadRequirements();
  };

  useEffect(() => {
    if (focusField && requirements) {
      startEditing();
      const timer = setTimeout(() => {
        const inputElement = document.getElementById(`nfr-input-${focusField}`);
        if (inputElement) {
          inputElement.focus();
          inputElement.scrollIntoView({ behavior: "smooth", block: "center" });
          inputElement.classList.add("ring-4", "ring-accent/40");
          setTimeout(() => {
            inputElement.classList.remove("ring-4", "ring-accent/40");
          }, 1500);
        }
        clearFocusField?.();
      }, 150);
      return () => clearTimeout(timer);
    }
  }, [focusField, requirements]);

  const handleSave = async () => {
    if (!requirements) return;
    setLoading(true);
    setError("");

    const updatedFunctional = editedFunctional
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);

    try {
      const res = await fetch(`/api/projects/${projectId}/requirements`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          functional: updatedFunctional,
          nonFunctional: editedNFR,
        }),
      });

      if (!res.ok) {
        throw new Error("Failed to save changes");
      }

      const data = await res.json();
      setRequirements(data.requirements);
      setEditMode(false);
      if (onSaveComplete) onSaveComplete();
    } catch (err: any) {
      setError(err.message || "Failed to save requirements.");
    } finally {
      setLoading(false);
    }
  };

  // Helper to render specified vs not specified fields
  const renderNFRField = (label: string, value: string, fieldName: keyof typeof editedNFR) => {
    // value is typed string, but that's only a compile-time claim -- a persisted record whose
    // extraction returned an incomplete nonFunctional object (confirmed live: {} with a field
    // missing entirely) makes this genuinely undefined at runtime. Guard the same way
    // ArchitectureWorkspace.tsx's isScaleUnspecified/isBudgetUnspecified/isDataUnspecified
    // already do, rather than crashing the whole page on a call site that didn't.
    const isNotSpecified = !value || value.toLowerCase() === "not_specified" || value.toLowerCase() === "not specified";

    if (editMode) {
      const suggestions = fieldSuggestions[fieldName] || [];
      return (
        <div className="space-y-1.5">
          <label
            htmlFor={`nfr-input-${fieldName}`}
            className="flex items-center gap-1.5 text-xs font-semibold text-ink-muted uppercase tracking-wider"
          >
            {label}
            {FIELD_EXPLANATIONS[fieldName] && <InfoTooltip text={FIELD_EXPLANATIONS[fieldName]} />}
          </label>
          {fieldName === "budget" ? (
            <BudgetInput
              id={`nfr-input-${fieldName}`}
              value={editedNFR.budget}
              onChange={(next) => setEditedNFR((prev) => ({ ...prev, budget: next }))}
            />
          ) : (
            <input
              id={`nfr-input-${fieldName}`}
              type="text"
              value={editedNFR[fieldName]}
              onChange={(e) =>
                setEditedNFR((prev) => ({ ...prev, [fieldName]: e.target.value }))
              }
              // A generous limit for a descriptive sentence or two -- these fields (scale,
              // read/write pattern, data types, etc.) are intentionally free text, often
              // LLM-populated with prose like "500-1000 concurrent riders, 200-400 drivers at
              // peak", not restricted to short categorical values.
              maxLength={300}
              className="w-full rounded-xl border border-line bg-white px-3 py-2 text-xs text-ink shadow-sm focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent transition-all duration-200"
            />
          )}
          {suggestionsLoading ? (
            <div className="flex items-center gap-1.5 text-[10px] text-ink-faint italic">
              <span className="h-2.5 w-2.5 animate-spin rounded-full border-2 border-accent border-t-transparent" />
              Generating suggestions...
            </div>
          ) : suggestions.length > 0 ? (
            <div className="flex flex-wrap gap-1">
              {suggestions.map((s, idx) => (
                <span
                  key={idx}
                  className="inline-flex max-w-full items-center gap-1 rounded-full border border-accent/25 bg-accent-soft py-0.5 pl-2 pr-1.5 transition hover:border-accent hover:bg-accent/15"
                >
                  <button
                    type="button"
                    onClick={() => applySuggestion(fieldName, s.value)}
                    className="max-w-[220px] truncate text-[10px] font-medium text-accent-ink"
                  >
                    {s.value}
                  </button>
                  {s.why && <InfoTooltip text={`Why suggested: ${s.why}`} />}
                  {s.sources && s.sources.length > 0 && (
                    <InfoTooltip
                      text={`Source: ${s.sources[0].book}${s.sources[0].page ? `, p.${s.sources[0].page}` : ""} — "${(s.sources[0].excerpt || "").slice(0, 220)}${(s.sources[0].excerpt?.length || 0) > 220 ? "..." : ""}"`}
                    />
                  )}
                </span>
              ))}
            </div>
          ) : suggestionsError ? (
            <p className="text-[10px] text-danger">⚠ {suggestionsError}</p>
          ) : null}
        </div>
      );
    }

    return (
      <div className="rounded-2xl border border-line bg-white p-4 shadow-sm">
        <dt className="flex items-center gap-1.5 text-xs font-semibold text-ink-faint uppercase tracking-wider">
          {label}
          {FIELD_EXPLANATIONS[fieldName] && <InfoTooltip text={FIELD_EXPLANATIONS[fieldName]} />}
        </dt>
        <dd className="mt-2 text-sm">
          {isNotSpecified ? (
            <span className="flex items-center justify-between text-ink-faint italic">
              <span>Not specified in brainstorm</span>
              <button
                onClick={startEditing}
                className="text-[10px] font-bold text-accent-ink uppercase tracking-wider hover:underline"
              >
                + specify
              </button>
            </span>
          ) : (
            <span className="text-ink font-medium">{value}</span>
          )}
        </dd>
      </div>
    );
  };

  if (loading && !extracting) {
    return (
      <div className="flex h-full flex-col items-center justify-center p-8 text-ink-muted">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-accent border-t-transparent" />
        <span className="mt-4 text-sm font-semibold">Loading your project details...</span>
      </div>
    );
  }

  if (extracting) {
    return (
      <div className="flex h-full flex-col items-center justify-center p-8 text-ink-muted text-center">
        <div className="h-10 w-10 animate-bounce rounded-full bg-accent flex items-center justify-center text-white font-bold text-xl shadow-md">
          ⚙️
        </div>
        <span className="mt-4 text-base font-semibold text-ink">{extractionStage}</span>
      </div>
    );
  }

  if (!requirements) {
    return (
      <div className="flex h-full flex-col items-center justify-center p-8 text-ink-muted text-center border-2 border-dashed border-line rounded-3xl">
        <span className="text-4xl">🔒</span>
        <h4 className="mt-4 font-bold text-ink">Requirements Locked</h4>
        <p className="mt-2 text-sm text-ink-muted max-w-xs">
          Finish chatting with the AI on the left first. Once you&apos;re done, it will automatically pull together what your product needs.
        </p>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col p-6 sm:p-8 overflow-y-auto">
      {/* Panel Header */}
      <div className="flex items-center justify-between border-b border-line pb-4">
        <div>
          <div className="flex items-center gap-2">
            <h3 className="text-xl font-bold text-ink">Your Project Details</h3>
            {requirements.industryContext &&
              INDUSTRY_BADGE[requirements.industryContext.industry as "fintech" | "healthtech"] && (
                <span className="inline-flex items-center gap-1 rounded-full bg-accent-soft border border-accent/25 px-2.5 py-1 text-[10px] font-bold text-accent-ink uppercase tracking-wider">
                  {INDUSTRY_BADGE[requirements.industryContext.industry as "fintech" | "healthtech"].emoji} Industry:{" "}
                  {INDUSTRY_BADGE[requirements.industryContext.industry as "fintech" | "healthtech"].label}
                </span>
              )}
          </div>
          <p className="text-xs text-ink-muted mt-1">
            Review and adjust these details before we design your cloud architecture.
          </p>
        </div>
        {!editMode && (
          <div className="flex items-center gap-2">
            <button
              onClick={handleManualRefresh}
              disabled={loading}
              title="Refresh"
              aria-label="Refresh requirements"
              className="rounded-xl border border-line bg-white px-2.5 py-2 text-xs font-semibold text-ink-muted shadow-sm transition hover:bg-paper active:scale-95 disabled:opacity-50"
            >
              🔄
            </button>
            <button
              onClick={startEditing}
              className="rounded-xl border border-line bg-white px-3.5 py-2 text-xs font-semibold text-ink-muted shadow-sm transition hover:bg-paper active:scale-95"
            >
              Edit
            </button>
          </div>
        )}
      </div>

      {/* Fallback safety net -- normally requirementsUpdated auto-refreshes silently, but this
          is deliberately skipped while editMode is active (see the listener above) so an
          in-progress edit is never clobbered. */}
      {hasStaleData && (
        <div className="mt-4 flex items-center justify-between gap-3 rounded-2xl border border-accent/30 bg-accent-soft px-4 py-2.5 text-xs font-semibold text-accent-ink">
          <span>New data available — refreshing will discard your in-progress edits.</span>
          <button
            onClick={handleManualRefresh}
            className="flex-none rounded-lg bg-accent px-3 py-1.5 text-[10px] font-extrabold uppercase text-white transition hover:bg-accent-ink"
          >
            Refresh
          </button>
        </div>
      )}

      {error && <p className="mt-4 text-xs font-medium text-danger">{error}</p>}

      {/* Main Content */}
      <div className="mt-6 flex-1 space-y-6">
        {/* Conversation Summary -- a readable brief of the discovery conversation, not the raw
            transcript (that's already visible in the chat panel). Cached server-side, so this
            only shows a loading state the very first time a given requirements version is
            viewed. */}
        <div>
          <h4 className="mb-3 flex items-center gap-2 text-sm font-bold text-ink">
            <span>📝</span> Conversation Summary
            <InfoTooltip text="A short summary of what you told the AI and what you both decided — not the full chat, just the highlights." />
          </h4>
          {summaryLoading ? (
            <div className="flex items-center gap-1.5 rounded-2xl bg-paper p-4 text-xs text-ink-faint italic">
              <span className="h-2.5 w-2.5 animate-spin rounded-full border-2 border-accent border-t-transparent" />
              Summarizing the conversation...
            </div>
          ) : conversationSummary ? (
            <div className="rounded-2xl bg-paper p-4">
              <p className="text-sm text-ink-muted leading-relaxed">{conversationSummary}</p>
              <SourceCitations sources={conversationSummarySources} />
            </div>
          ) : (
            <p className="rounded-2xl bg-paper p-4 text-xs text-ink-faint italic">Summary unavailable.</p>
          )}
        </div>

        {/* Functional Requirements */}
        <div>
          <h4 className="mb-3 flex items-center gap-2 text-sm font-bold text-ink">
            <span>🚀</span> What It Does
            <InfoTooltip text={FIELD_EXPLANATIONS.functional} />
          </h4>
          {editMode ? (
            <div className="space-y-1.5">
              <label htmlFor="nfr-functional" className="text-xs font-semibold text-ink-muted uppercase tracking-wider">
                Features (one per line)
              </label>
              <textarea
                id="nfr-functional"
                rows={5}
                value={editedFunctional}
                onChange={(e) => setEditedFunctional(e.target.value)}
                className="w-full rounded-2xl border border-line bg-white px-4 py-3 text-sm text-ink shadow-sm focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent resize-none"
              />
              {suggestionsLoading ? (
                <div className="flex items-center gap-1.5 text-[10px] text-ink-faint italic">
                  <span className="h-2.5 w-2.5 animate-spin rounded-full border-2 border-accent border-t-transparent" />
                  Generating suggestions...
                </div>
              ) : (fieldSuggestions.functional || []).length > 0 ? (
                <div>
                  <span className="text-[10px] font-semibold text-ink-faint uppercase tracking-wider">
                    + Suggested additions
                  </span>
                  <div className="mt-1 flex flex-wrap gap-1">
                    {(fieldSuggestions.functional || []).map((s, idx) => (
                      <span
                        key={idx}
                        className="inline-flex max-w-full items-center gap-1 rounded-full border border-accent/25 bg-accent-soft py-0.5 pl-2 pr-1.5 transition hover:border-accent hover:bg-accent/15"
                      >
                        <button
                          type="button"
                          onClick={() => applyFunctionalSuggestion(s.value)}
                          className="max-w-[220px] truncate text-[10px] font-medium text-accent-ink"
                        >
                          + {s.value}
                        </button>
                        {s.why && <InfoTooltip text={`Why suggested: ${s.why}`} />}
                      </span>
                    ))}
                  </div>
                </div>
              ) : suggestionsError ? (
                <p className="text-[10px] text-danger">⚠ {suggestionsError}</p>
              ) : null}
            </div>
          ) : (
            <ul className="grid gap-2 text-sm text-ink-muted rounded-3xl bg-paper p-5">
              {requirements.functional.map((func, index) => (
                <li key={index} className="flex gap-3">
                  <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-accent-soft" />
                  <span className="leading-5">{func}</span>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* Non-Functional Requirements */}
        <div>
          <h4 className="text-sm font-bold text-ink mb-4 flex items-center gap-2">
            <span>⚙️</span> How It Should Perform
            <InfoTooltip text="Non-functional requirements (NFRs): constraints on HOW the system behaves (speed, cost, scale) rather than WHAT it does. These drive most of the technical decisions in your generated architecture." />
          </h4>
          <div className="grid gap-4 md:grid-cols-2">
            {renderNFRField("Expected Traffic / Scale", requirements.nonFunctional.expectedScale, "expectedScale")}
            {renderNFRField("Mostly Saving or Looking Up Data?", requirements.nonFunctional.readWritePattern, "readWritePattern")}
            {renderNFRField("Data Types", requirements.nonFunctional.dataNature, "dataNature")}
            {renderNFRField("How Fast It Needs to Feel", requirements.nonFunctional.latencySensitivity, "latencySensitivity")}
            {renderNFRField("Budget Range", requirements.nonFunctional.budget, "budget")}
            {renderNFRField("Your Team's Cloud/Tech Experience", requirements.nonFunctional.teamMaturity, "teamMaturity")}
            {renderNFRField("Security & Compliance", requirements.nonFunctional.compliance, "compliance")}
          </div>
        </div>
      </div>

      {/* Edit Mode Actions */}
      {editMode && (
        <div className="mt-8 border-t border-line pt-4 flex justify-end gap-3">
          <button
            onClick={() => setEditMode(false)}
            className="rounded-xl border border-line bg-white px-4 py-2.5 text-xs font-semibold text-ink-muted shadow-sm hover:bg-paper"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            className="rounded-xl bg-ink px-4 py-2.5 text-xs font-semibold text-white shadow-md hover:bg-ink/90"
          >
            Save Requirements
          </button>
        </div>
      )}

      {/* Workspace Footer Action */}
      {!editMode && (
        <div className="mt-8 border-t border-line pt-6">
          <div className="mb-2 flex items-center justify-center gap-1.5 text-center text-[11px] text-ink-faint">
            <span>Takes you to the Architecture tab, where you can generate or review the design</span>
            <InfoTooltip text="Nothing changes on this screen — your architecture gets built on the Architecture Diagram tab, using whatever you've saved here." />
          </div>
          <button
            className="flex w-full items-center justify-center rounded-2xl bg-accent px-5 py-3.5 text-sm font-semibold text-white shadow-md transition-all hover:bg-accent-ink active:scale-[0.98]"
            onClick={() => onGoToArchitecture?.()}
          >
            Go to Architecture Diagram ➜
          </button>
        </div>
      )}
    </div>
  );
}
