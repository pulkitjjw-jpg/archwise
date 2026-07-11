"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import InfoTooltip from "./InfoTooltip";

type ConversationTurn = {
  id: string;
  role: string;
  message: string;
  stage: string;
  suggestedReplies?: string[];
  createdAt: string | Date;
};

interface ChatAreaProps {
  projectId: string;
  initialConversations: ConversationTurn[];
}

export default function ChatArea({ projectId, initialConversations }: ChatAreaProps) {
  const [messages, setMessages] = useState<ConversationTurn[]>(initialConversations);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const chatEndRef = useRef<HTMLDivElement>(null);

  // Scroll to bottom on new messages or typing indicator
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, sending]);

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

        // Auto-extract requirements if LLM confirms the change was clear
        if (assistantConversation.stage === "requirement_gathering" && isGrowthPhase) {
          try {
            await fetch(`/api/projects/${projectId}/requirements`, {
              method: "POST",
            });
            window.dispatchEvent(new Event("requirementsUpdated"));
          } catch (err) {
            console.error("Auto extraction failed:", err);
          }
        }
      } catch (error) {
        console.error("Error sending message:", error);
      } finally {
        setSending(false);
      }
    },
    [sending, isGrowthPhase, projectId]
  );

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
                  isUser
                    ? "bg-accent text-white rounded-br-none"
                    : "bg-paper text-ink rounded-bl-none border border-line"
                }`}
              >
                <div className="font-bold text-[10px] uppercase tracking-wider mb-1 opacity-75">
                  {isUser ? "You" : "Assistant"}
                </div>
                <p className="whitespace-pre-wrap">{msg.message}</p>
                <div className="text-[9px] text-right mt-1 opacity-60">
                  {new Date(msg.createdAt).toLocaleTimeString([], {
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                </div>
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
              <div className="flex items-center gap-1 py-1">
                <span className="h-2 w-2 animate-bounce rounded-full bg-ink-faint [animation-delay:-0.3s]" />
                <span className="h-2 w-2 animate-bounce rounded-full bg-ink-faint [animation-delay:-0.15s]" />
                <span className="h-2 w-2 animate-bounce rounded-full bg-ink-faint" />
              </div>
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
