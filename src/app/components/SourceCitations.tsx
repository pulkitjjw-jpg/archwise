"use client";

import { useState } from "react";
import { Icon } from "@iconify/react";

export type Citation = {
  book: string;
  author?: string;
  chapterOrSection?: string | null;
  page?: string | null;
  excerpt?: string;
  // Domain-awareness Part 2 -- "reference-architecture" (AWS/Azure/GCP's own published guide for
  // a specific product domain, an established provider-endorsed PATTERN) vs "principle" (default;
  // one of the 5 general architecture/software-engineering books, timeless PRINCIPLE). Both build
  // credibility but signal a different kind of grounding, so the label itself changes ("Pattern
  // Source" vs "Principle Source"), not just the linked book.
  sourceType?: "principle" | "reference-architecture";
  sourceUrl?: string | null;
};

// Knowledge-base RAG citation display -- deliberately understated (small, faint, below the
// reasoning it supports) rather than inline in the prose. This is a credibility signal, not a
// primary piece of content: the reasoning text itself was already written to stand on its own,
// so a citation here should read as "here's where this came from if you want to check," not
// compete with the reasoning for attention. Never rendered at all when there's nothing to cite --
// callers pass sources straight through from the API response, which only ever contains entries
// the retrieval pipeline actually found and verified against a real stored excerpt (see backend
// enrich_citations) -- there is no "no citation available" placeholder state to render here.
export default function SourceCitations({ sources }: { sources?: Citation[] | null }) {
  const [expandedIndex, setExpandedIndex] = useState<number | null>(null);
  if (!sources || sources.length === 0) return null;

  return (
    <div className="mt-1.5 flex flex-col gap-1">
      {sources.map((s, idx) => {
        const isExpanded = expandedIndex === idx;
        const isPattern = s.sourceType === "reference-architecture";
        const label = isPattern ? "Official Guide" : "Best-Practice Reference";
        return (
          <div key={idx}>
            <button
              type="button"
              onClick={() => setExpandedIndex(isExpanded ? null : idx)}
              className={`inline-flex items-center gap-1 text-[10px] font-medium transition ${
                isPattern ? "text-accent-ink/70 hover:text-accent-ink" : "text-ink-faint hover:text-accent-ink"
              }`}
            >
              <Icon
                icon={isPattern ? "mdi:map-marker-path" : "mdi:book-open-page-variant-outline"}
                width={11}
                height={11}
                className="flex-none"
              />
              <span className="truncate">
                {label}: {s.book}
                {s.page ? `, p.${s.page}` : ""}
              </span>
              <Icon icon={isExpanded ? "mdi:chevron-up" : "mdi:chevron-down"} width={11} height={11} className="flex-none" />
            </button>
            {isExpanded && (
              <div className="mt-1 ml-4 rounded-lg border border-line bg-paper/70 p-2.5 text-[10.5px] leading-relaxed text-ink-muted animate-fadeIn">
                {s.chapterOrSection && (
                  <div className="mb-1 text-[9px] font-bold uppercase tracking-wide text-ink-faint">{s.chapterOrSection}</div>
                )}
                {s.excerpt && <p className="italic">&ldquo;{s.excerpt}&rdquo;</p>}
                {s.author && <div className="mt-1.5 text-[9px] text-ink-faint">— {s.author}</div>}
                {s.sourceUrl && (
                  <a
                    href={s.sourceUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="mt-1.5 block text-[9px] text-accent-ink hover:underline"
                  >
                    View original source ↗
                  </a>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
