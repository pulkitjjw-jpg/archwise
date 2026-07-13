"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import InfoTooltip from "./InfoTooltip";
import { useStagedLoadingMessage } from "@/app/hooks/useStagedLoadingMessage";
import { useGrowthTrigger } from "@/app/contexts/GrowthTriggerContext";

// The assistant sometimes writes structured replies (bold labels, bullet lists) using markdown
// syntax -- rendered here instead of left as raw "**text**"/"- item" characters, which otherwise
// reads like an unprocessed model response pasted directly into the chat. User-typed messages are
// NOT run through this -- a user typing a literal "*" or "-" shouldn't have it reinterpreted.
const ASSISTANT_MARKDOWN_COMPONENTS = {
  p: ({ children }: { children?: React.ReactNode }) => <p className="mb-2 whitespace-pre-wrap last:mb-0">{children}</p>,
  ul: ({ children }: { children?: React.ReactNode }) => <ul className="mb-2 list-disc space-y-0.5 pl-4 last:mb-0">{children}</ul>,
  ol: ({ children }: { children?: React.ReactNode }) => <ol className="mb-2 list-decimal space-y-0.5 pl-4 last:mb-0">{children}</ol>,
  li: ({ children }: { children?: React.ReactNode }) => <li>{children}</li>,
  strong: ({ children }: { children?: React.ReactNode }) => <strong className="font-bold">{children}</strong>,
  em: ({ children }: { children?: React.ReactNode }) => <em className="italic">{children}</em>,
  a: ({ children, href }: { children?: React.ReactNode; href?: string }) => (
    <a href={href} target="_blank" rel="noopener noreferrer" className="underline">
      {children}
    </a>
  ),
  code: ({ children }: { children?: React.ReactNode }) => (
    <code className="rounded bg-ink/10 px-1 py-0.5 text-[0.85em]">{children}</code>
  ),
};

// Short, natural-feeling phrases shown while a brainstorm reply is in flight -- the backend may
// be walking a multi-model fallback chain under the hood if the primary model is unavailable,
// but that mechanic is never surfaced here; these just make the wait feel like normal "thinking"
// time instead of an unmoving typing indicator. Brainstorm turns are normally fast (a few
// seconds), so this cycles faster than the ~30-45s architecture-generation wait.
const THINKING_STAGES = [
  "Reading through what you've shared...",
  "Thinking through the details...",
  "Considering what to ask next...",
  "Almost there...",
];
const THINKING_STAGE_INTERVAL_MS = 3000;

// Shown after a growth-trigger conversation concludes -- the assistant's own reply has already
// arrived by this point (that's the THINKING_STAGES window above), but real background work
// keeps going afterward: analyzing which components the request affects, then, once approved,
// saving the updated architecture. Without this, the chat looks "done" the moment the assistant's
// message appears even though nothing has actually been updated yet.
const ANALYZING_STAGES = [
  "Reviewing your requested changes...",
  "Working out which parts of the architecture are affected...",
  "Almost done...",
];
const APPLYING_STAGES = ["Updating the architecture...", "Saving the new version..."];
const GROWTH_STAGE_INTERVAL_MS = 3200;

type ConversationTurn = {
  id: string;
  role: string;
  message: string;
  stage: string;
  suggestedReplies?: string[];
  createdAt: string | Date;
  // Client-only, never persisted -- set on the optimistically-added user bubble when the send
  // itself fails, so the message doesn't sit there looking successfully sent with no way to
  // recover the (already-cleared) input text. See sendMessage's catch block and handleRetrySend.
  failed?: boolean;
};

interface ChatAreaProps {
  projectId: string;
  initialConversations: ConversationTurn[];
}

export default function ChatArea({ projectId, initialConversations }: ChatAreaProps) {
  const [messages, setMessages] = useState<ConversationTurn[]>(initialConversations);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const thinkingStage = useStagedLoadingMessage(sending, THINKING_STAGES, THINKING_STAGE_INTERVAL_MS);
  const chatEndRef = useRef<HTMLDivElement>(null);
  const growthTrigger = useGrowthTrigger();
  const analyzingStage = useStagedLoadingMessage(
    growthTrigger.status === "analyzing",
    ANALYZING_STAGES,
    GROWTH_STAGE_INTERVAL_MS
  );
  const applyingStage = useStagedLoadingMessage(
    growthTrigger.status === "applying",
    APPLYING_STAGES,
    GROWTH_STAGE_INTERVAL_MS
  );

  // Scroll to bottom on new messages, the typing indicator, or the growth-trigger banner
  // appearing/changing state.
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, sending, growthTrigger.status]);

  const latestMessage = messages[messages.length - 1];
  const latestStage = latestMessage?.stage || "intake";
  const isGrowthPhase = latestStage === "growth_trigger" || latestStage === "requirement_gathering";

  const sendMessage = useCallback(
    async (rawText: string) => {
      const userMessageText = rawText.trim();
      if (!userMessageText || sending) return;

      setInput("");
      setSending(true);

      const activeStage = isGrowthPhase ? "growth_trigger" : "brainstorm";

      const tempMessage: ConversationTurn = {
        id: crypto.randomUUID(),
        role: "user",
        message: userMessageText,
        stage: activeStage,
        createdAt: new Date(),
      };

      setMessages((prev) => [...prev, tempMessage]);

      try {
        const response = await fetch(`/api/projects/${projectId}/conversations`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            role: "user",
            message: userMessageText,
            stage: activeStage,
          }),
        });

        if (!response.ok) {
          throw new Error("Failed to save message");
        }

        const { userConversation, assistantConversation } = await response.json();

        // Replace user temp message with database turn, and append assistant response
        setMessages((prev) =>
          prev
            .map((msg) => (msg.id === tempMessage.id ? userConversation : msg))
            .concat(assistantConversation)
        );

        // Auto-extract requirements whenever the LLM concludes discovery has enough detail --
        // both the very first brainstorm's conclusion AND every later growth-trigger's
        // conclusion land here (assistantConversation.stage transitions to
        // "requirement_gathering" in both cases). Previously this was gated on isGrowthPhase,
        // which is false for the very first completion (computed from the stage *before* this
        // send), so the Requirements tab never auto-refreshed after the initial brainstorm
        // without a page reload -- extraction only ran later, lazily, when RequirementsPanel
        // happened to mount fresh. Dispatching "requirementsUpdated" unconditionally here fixes
        // that: RequirementsPanel now listens for it directly (see RequirementsPanel.tsx).
        if (assistantConversation.stage === "requirement_gathering") {
          try {
            await fetch(`/api/projects/${projectId}/requirements`, {
              method: "POST",
            });
            window.dispatchEvent(new Event("requirementsUpdated"));

            // The chat-proposed-changes review flow only makes sense for a growth trigger
            // against an *existing* architecture -- the very first completion has no
            // architecture yet to propose changes against.
            if (isGrowthPhase) {
              // Gather this growth-trigger's full description from fresh server-side history
              // (not the local `messages` closure, which can be stale) so multi-turn
              // clarification isn't lost, then hand it to the shared GrowthTriggerContext so
              // it can propose component-level changes for review -- see
              // ArchitectureWorkspace, which reads the same context rather than needing its
              // own listener attached (previously a `window` CustomEvent, silently dropped
              // whenever ArchitectureWorkspace wasn't mounted -- e.g. the user still on the
              // Requirements tab, which is the default).
              const historyRes = await fetch(`/api/projects/${projectId}/conversations`);
              if (historyRes.ok) {
                const { conversations } = await historyRes.json();
                const growthDescription = conversations
                  .filter((c: ConversationTurn) => c.role === "user" && c.stage === "growth_trigger")
                  .map((c: ConversationTurn) => c.message)
                  .join(" ");
                if (growthDescription.trim()) {
                  growthTrigger.startGrowthTrigger(projectId, growthDescription);
                }
              }
            }
          } catch (err) {
            console.error("Auto extraction failed:", err);
          }
        }
      } catch (error) {
        console.error("Error sending message:", error);
        // Mark the optimistic bubble as failed instead of leaving it looking identical to a
        // successfully-sent message -- the input was already cleared above, so this (plus the
        // Retry affordance in the render below) is the user's only way to recover.
        setMessages((prev) => prev.map((msg) => (msg.id === tempMessage.id ? { ...msg, failed: true } : msg)));
      } finally {
        setSending(false);
      }
    },
    [sending, isGrowthPhase, projectId, growthTrigger.startGrowthTrigger]
  );

  const handleRetrySend = (failedMessage: ConversationTurn) => {
    setMessages((prev) => prev.filter((msg) => msg.id !== failedMessage.id));
    sendMessage(failedMessage.message);
  };

  const handleSend = (e: React.FormEvent) => {
    e.preventDefault();
    sendMessage(input);
  };

  const handleSuggestionClick = (suggestion: string) => {
    sendMessage(suggestion);
  };

  // Suggested quick-reply chips only make sense for the latest, still-unanswered assistant
  // question -- once the user has replied, the next assistant turn carries its own suggestions.
  const activeSuggestions =
    latestMessage?.role === "assistant" && !sending ? latestMessage.suggestedReplies || [] : [];

  // Calculate progress percentage
  let progressPercent = 15;
  let stageLabel = "Project Intake";
  if (latestStage === "brainstorm") {
    progressPercent = 60;
    stageLabel = "Brainstorming Architecture Details";
  } else if (latestStage === "growth_trigger") {
    progressPercent = 85;
    stageLabel = "Refining Growth Triggers / Changes";
  } else if (latestStage === "requirement_gathering") {
    progressPercent = 100;
    stageLabel = "Discovery & Updates Concluded";
  }

  return (
    <div className="flex h-[calc(100vh-12rem)] flex-col rounded-[2rem] border border-white/60 bg-white/70 shadow-xl backdrop-blur-md overflow-hidden">
      {/* Chat Header */}
      <div className="border-b border-line bg-ink px-6 py-4 text-white">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="font-bold tracking-tight">Interactive Discovery Chat</h3>
            <p className="text-xs text-accent-on-dark font-semibold uppercase tracking-wider mt-0.5">
              {stageLabel}
            </p>
          </div>
          <span className="flex items-center gap-1.5 rounded-full bg-white/10 px-3 py-1 text-xs font-semibold">
            {progressPercent}%
            <InfoTooltip
              text="How far along the discovery conversation is — not a countdown to a fixed number of questions, just a rough sense of progress toward having enough detail to generate an architecture."
              variant="dark"
            />
          </span>
        </div>

        {/* Progress Bar */}
        <div className="mt-3 h-1.5 w-full rounded-full bg-white/20 overflow-hidden">
          <div
            className="h-full bg-accent-on-dark transition-all duration-500 ease-out"
            style={{ width: `${progressPercent}%` }}
          />
        </div>
      </div>

      {/* Messages Scroll Area */}
      <div className="flex-1 overflow-y-auto p-6 space-y-4">
        {messages.map((msg) => {
          const isUser = msg.role === "user";
          return (
            <div
              key={msg.id}
              className={`flex ${isUser ? "justify-end" : "justify-start"}`}
            >
              <div
                className={`max-w-[80%] rounded-[1.5rem] px-5 py-3 text-sm leading-relaxed shadow-sm ${
                  msg.failed
                    ? "bg-danger-soft text-ink border border-danger/40 rounded-br-none"
                    : isUser
                      ? "bg-accent text-white rounded-br-none"
                      : "bg-paper text-ink rounded-bl-none border border-line"
                }`}
              >
                <div className="font-bold text-[10px] uppercase tracking-wider mb-1 opacity-75">
                  {isUser ? "You" : "Assistant"}
                </div>
                {isUser ? (
                  <p className="whitespace-pre-wrap">{msg.message}</p>
                ) : (
                  <ReactMarkdown components={ASSISTANT_MARKDOWN_COMPONENTS}>{msg.message}</ReactMarkdown>
                )}
                {msg.failed ? (
                  <div className="mt-2 flex items-center gap-2 text-[11px] font-semibold text-danger">
                    <span>⚠ Failed to send</span>
                    <button
                      onClick={() => handleRetrySend(msg)}
                      className="rounded-full border border-danger/40 px-2.5 py-0.5 text-danger transition hover:bg-danger/10"
                    >
                      Retry
                    </button>
                  </div>
                ) : (
                  <div className="text-[9px] text-right mt-1 opacity-60">
                    {/* Locale pinned explicitly (not the runtime default) so the SSR pass and the
                        browser always format this identically -- an unspecified locale/hour12 can
                        resolve differently between Node and the browser even for the same wall-clock
                        time, which is a hydration mismatch. */}
                    {new Date(msg.createdAt).toLocaleTimeString("en-US", {
                      hour: "2-digit",
                      minute: "2-digit",
                      hour12: true,
                    })}
                  </div>
                )}
              </div>
            </div>
          );
        })}

        {/* Typing Indicator */}
        {sending && (
          <div className="flex justify-start">
            <div className="bg-paper border border-line text-ink rounded-[1.5rem] rounded-bl-none px-5 py-3 shadow-sm max-w-[80%]">
              <div className="font-bold text-[10px] uppercase tracking-wider mb-1 opacity-75">
                Assistant
              </div>
              <div className="flex items-center gap-2 py-1">
                <div className="flex items-center gap-1">
                  <span className="h-2 w-2 animate-bounce rounded-full bg-ink-faint [animation-delay:-0.3s]" />
                  <span className="h-2 w-2 animate-bounce rounded-full bg-ink-faint [animation-delay:-0.15s]" />
                  <span className="h-2 w-2 animate-bounce rounded-full bg-ink-faint" />
                </div>
                <span className="text-xs text-ink-muted italic">{thinkingStage}</span>
              </div>
            </div>
          </div>
        )}
        {/* Growth-trigger processing banner -- persists independently of the typing indicator
            above (which only covers the assistant's own reply). Real work keeps happening after
            that reply appears: analyzing which components the request affects, then, once
            approved on the Architecture tab, saving the new version. Without this the chat looks
            "done" the moment the assistant's message lands even though nothing has actually
            updated yet. */}
        {growthTrigger.status !== "idle" && growthTrigger.status !== "done" && (
          <div className="flex justify-start">
            <div className="max-w-[80%] rounded-[1.5rem] rounded-bl-none border border-accent/25 bg-accent-soft/60 px-5 py-3 shadow-sm">
              <div className="mb-1 text-[10px] font-bold uppercase tracking-wider text-accent-ink opacity-75">
                Architecture Update
              </div>
              {growthTrigger.status === "analyzing" && (
                <div className="flex items-center gap-2 py-1">
                  <span className="h-3 w-3 flex-none animate-spin rounded-full border-2 border-accent border-t-transparent" />
                  <span className="text-xs italic text-ink-muted">{analyzingStage}</span>
                </div>
              )}
              {growthTrigger.status === "ready" && (
                <p className="text-xs text-ink">
                  {growthTrigger.proposals.length > 0
                    ? `Found ${growthTrigger.proposals.length} proposed change${growthTrigger.proposals.length === 1 ? "" : "s"} — head to the Architecture tab to review and approve.`
                    : "No architecture changes were needed for this request."}
                </p>
              )}
              {growthTrigger.status === "applying" && (
                <div className="flex items-center gap-2 py-1">
                  <span className="h-3 w-3 flex-none animate-spin rounded-full border-2 border-accent border-t-transparent" />
                  <span className="text-xs italic text-ink-muted">{applyingStage}</span>
                </div>
              )}
              {growthTrigger.status === "error" && (
                <p className="text-xs text-danger">{growthTrigger.error || "Something went wrong analyzing the requested changes."}</p>
              )}
            </div>
          </div>
        )}
        <div ref={chatEndRef} />
      </div>

      {/* Message Input Form */}
      <div className="border-t border-line bg-paper/50 p-4 space-y-3">
        {latestStage === "requirement_gathering" && (
          <div className="flex items-center justify-center gap-1.5 rounded-xl bg-success-soft/70 border border-success/25 p-2 text-center text-xs">
            <span className="font-semibold text-success">Discovery concluded.</span>{" "}
            <span className="text-success">Need to report changes? Type a growth trigger below.</span>
            <InfoTooltip text="A 'growth trigger' just means describing a change to your product — new scale, a new feature, a bigger budget. Typing one here updates your requirements and lets you regenerate an updated architecture, without starting over." />
          </div>
        )}

        {/* AI-suggested quick replies -- tailored to this question by the LLM, not a static
            list. Selecting one sends it immediately; typing a custom answer is still just as
            available below. */}
        {activeSuggestions.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {activeSuggestions.map((suggestion, idx) => (
              <button
                key={idx}
                type="button"
                onClick={() => handleSuggestionClick(suggestion)}
                className="rounded-full border border-accent/25 bg-accent-soft px-3 py-1.5 text-left text-xs font-medium text-accent-ink transition hover:border-accent hover:bg-accent/15"
              >
                {suggestion}
              </button>
            ))}
          </div>
        )}

        <form onSubmit={handleSend}>
          <div className="flex gap-2">
            <input
              type="text"
              placeholder={
                latestStage === "requirement_gathering"
                  ? "Report a change (e.g. 'scale increased to 50k users')..."
                  : "Type your message here to answer or add context..."
              }
              value={input}
              onChange={(e) => setInput(e.target.value)}
              disabled={sending}
              className="flex-1 rounded-xl border border-line bg-white px-4 py-3 text-sm text-ink shadow-sm focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent disabled:opacity-50"
            />
            <button
              type="submit"
              disabled={!input.trim() || sending}
              className="rounded-xl bg-ink px-5 py-3 text-sm font-semibold text-white shadow-md transition-all hover:bg-ink/90 active:scale-95 disabled:opacity-50"
            >
              Send
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
