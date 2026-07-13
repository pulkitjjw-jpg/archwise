"use client";

import { useEffect, useState } from "react";

/**
 * Cycles through a list of short "thinking" phrases while `active` is true, advancing one stage
 * every `intervalMs`. Used to make a long single-request wait (the backend may be walking a
 * multi-model fallback chain under the hood) feel like normal AI "thinking" time rather than an
 * unmoving spinner -- deliberately NOT tied to real server progress events, and never exposes
 * which model/attempt is actually running underneath.
 */
export function useStagedLoadingMessage(active: boolean, stages: string[], intervalMs: number): string {
  const [stageIndex, setStageIndex] = useState(0);

  useEffect(() => {
    if (!active) {
      setStageIndex(0);
      return;
    }
    const interval = setInterval(() => {
      setStageIndex((prev) => Math.min(prev + 1, stages.length - 1));
    }, intervalMs);
    return () => clearInterval(interval);
  }, [active, intervalMs, stages.length]);

  return stages[stageIndex];
}
