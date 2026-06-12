import type { ExtractedLinkContent } from "../../../content/index.js";
import { buildLengthPartsForFinishLine } from "../../finish-line.js";
export { buildModelMetaFromAttempt } from "../../model-meta.js";
import type { ModelAttempt } from "../../types.js";
import type { UrlFlowContext } from "./types.js";

export function buildFinishExtras({
  extracted,
  metricsDetailed,
  transcriptionCostLabel,
}: {
  extracted: ExtractedLinkContent;
  metricsDetailed: boolean;
  transcriptionCostLabel: string | null;
}) {
  const parts = [
    ...(buildLengthPartsForFinishLine(extracted, metricsDetailed) ?? []),
    ...(transcriptionCostLabel ? [transcriptionCostLabel] : []),
  ];
  return parts.length > 0 ? parts : null;
}

export function pickModelForFinishLine(
  llmCalls: UrlFlowContext["model"]["llmCalls"],
  fallback: string | null,
) {
  const findLastModel = (purpose: (typeof llmCalls)[number]["purpose"]): string | null => {
    for (let i = llmCalls.length - 1; i >= 0; i -= 1) {
      const call = llmCalls[i];
      if (call && call.purpose === purpose) return call.model;
    }
    return null;
  };

  const summaryModel = findLastModel("summary");
  if (summaryModel) return summaryModel;

  const markdownModel = findLastModel("markdown");
  if (markdownModel) return markdownModel;

  const lastCall = llmCalls.at(-1);
  if (lastCall?.model) return lastCall.model;

  return fallback;
}
