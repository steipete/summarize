import type { PanelPhase } from "./types";

type SummaryEmptyStateInput = {
  tabTitle: string | null;
  tabUrl: string | null;
  autoSummarize: boolean;
  phase: PanelPhase;
  hasSlides: boolean;
};

export type SummaryEmptyState = {
  title: string;
  message: string;
};

export function buildSummaryEmptyState(input: SummaryEmptyStateInput): SummaryEmptyState | null {
  if (input.hasSlides) return null;

  const subject = input.tabTitle?.trim() || input.tabUrl?.trim() || "this page";
  if (!input.tabUrl) {
    return {
      title: "Open a page to summarize",
      message: "Summaries and slide output appear here.",
    };
  }

  if (input.phase === "connecting" || input.phase === "streaming" || input.autoSummarize) {
    return {
      title: "Summarizing this page...",
      message: `Waiting for ${subject}.`,
    };
  }

  return {
    title: "Ready to summarize",
    message: `Click Summarize to analyze ${subject}.`,
  };
}
