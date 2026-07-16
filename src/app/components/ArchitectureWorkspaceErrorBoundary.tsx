"use client";

import * as Sentry from "@sentry/nextjs";
import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
}

// Class-based React error boundary scoped around ArchitectureWorkspace.tsx specifically (see
// WorkspaceTabs.tsx, its mount point) -- the app's highest-risk component at 4000+ lines with
// the most runtime surface (SVG diagram rendering, manual editor, multi-provider cloud mapping,
// terraform export). App Router's error.tsx (src/app/error.tsx) catches errors thrown during
// this subtree's render too, but its reset() re-renders the WHOLE route segment (including the
// Requirements tab and everything else under WorkspaceTabs) -- a boundary scoped to just this
// already-mounted client subtree means a render error here doesn't take the rest of the
// workspace page down with it, and "Try again" only needs to retry ArchitectureWorkspace itself.
//
// Must be class-based -- React has no hook-based equivalent to componentDidCatch /
// getDerivedStateFromError as of React 19.
export default class ArchitectureWorkspaceErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false };

  static getDerivedStateFromError(): State {
    return { hasError: true };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    // Sentry.captureException is a safe no-op when the SDK was never initialized (unset
    // NEXT_PUBLIC_SENTRY_DSN, the current default) -- see src/instrumentation-client.ts.
    Sentry.captureException(error, {
      contexts: { react: { componentStack: errorInfo.componentStack } },
    });
  }

  handleRetry = () => {
    this.setState({ hasError: false });
  };

  render() {
    if (this.state.hasError) {
      return (
        <div className="flex h-full min-h-[24rem] flex-col items-center justify-center gap-4 p-8 text-center">
          <span className="inline-flex items-center gap-1.5 rounded-full border border-danger/25 bg-danger-soft px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider text-danger">
            Workspace error
          </span>
          <h2 className="text-lg font-black tracking-tight text-ink">
            The architecture workspace hit a problem
          </h2>
          <p className="max-w-sm text-sm leading-relaxed text-ink-muted">
            Something went wrong rendering the diagram. It&apos;s been reported automatically —
            try again, or switch to the Requirements tab and come back.
          </p>
          <button
            onClick={this.handleRetry}
            className="rounded-xl bg-ink px-4 py-2.5 text-sm font-bold text-white transition hover:opacity-90"
          >
            Try again
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}
