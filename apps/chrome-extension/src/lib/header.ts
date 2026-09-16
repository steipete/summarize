import type { MessageDescriptor } from "@steipete/summarize-core/localization";
import { readLocalizedMessage, type LocalizedText } from "./i18n";
export function buildIdleSubtitle({
  inputSummary,
  inputSummaryMessage,
  modelLabel,
  model,
}: {
  inputSummary?: string | null;
  inputSummaryMessage?: MessageDescriptor | null;
  modelLabel?: string | null;
  model?: string | null;
}): LocalizedText {
  const input = typeof inputSummary === "string" ? inputSummary.trim() : "";
  void modelLabel;
  void model;
  return readLocalizedMessage(inputSummaryMessage) ?? input;
}
