import { message as uiMessage, type LocalizedText } from "../../lib/i18n";
import type { PanelPhase } from "./types";

type SummaryEmptyStateInput = {
  tabTitle: string | null;
  tabUrl: string | null;
  autoSummarize: boolean;
  phase: PanelPhase;
  hasSlides: boolean;
};

export type SummaryEmptyState = {
  label: LocalizedText;
  message: LocalizedText;
  detail: string | null;
};

export function buildSummaryEmptyState(input: SummaryEmptyStateInput): SummaryEmptyState | null {
  if (input.hasSlides) return null;

  const subject = input.tabTitle?.trim() || input.tabUrl?.trim() || null;
  if (!input.tabUrl) {
    return {
      label: uiMessage("no.page"),
      message: uiMessage("open.a.page.to.summarize"),
      detail: null,
    };
  }

  if (input.phase === "connecting" || input.phase === "streaming" || input.autoSummarize) {
    return {
      label: uiMessage("loading.alternate"),
      message: uiMessage("preparing.summary"),
      detail: subject,
    };
  }

  return {
    label: uiMessage("ready"),
    message: uiMessage("click.summarize.to.start"),
    detail: subject,
  };
}
