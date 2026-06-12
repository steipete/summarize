import type { UrlSummaryResolution } from "../engine/web-summary.js";
import type { AssetSummaryResult } from "../run/flows/asset/types.js";

export type UrlSummaryPresentationResolution =
  | {
      kind: "use-extracted";
      footerLabel: string;
      verboseMessage: string | null;
    }
  | {
      kind: "summary";
      normalizedSummary: string;
      summaryEmitted: boolean;
      summaryFromCache: boolean;
      llm: {
        provider: string;
        model: string;
        canonical: string;
        maxCompletionTokens: number | null;
      };
    };

export type SummarizeExecutionDetails =
  | {
      kind: "visible-page";
    }
  | {
      kind: "url-summary";
      prompt: string;
      effectiveMarkdownMode: "off" | "auto" | "llm" | "readability";
      resolution: UrlSummaryPresentationResolution;
    }
  | {
      kind: "delegated-asset";
      summaryEmitted: boolean;
      summary: AssetSummaryResult;
    };

export type SummarizeExtractionDetails = {
  kind: "url-extraction";
  prompt: string;
  effectiveMarkdownMode: "off" | "auto" | "llm" | "readability";
};

export function toUrlSummaryPresentationResolution(
  resolution: UrlSummaryResolution,
): UrlSummaryPresentationResolution {
  if (resolution.kind === "use-extracted") {
    return resolution;
  }
  return {
    kind: "summary",
    normalizedSummary: resolution.normalizedSummary,
    summaryEmitted: resolution.summaryEmitted,
    summaryFromCache: resolution.summaryFromCache,
    llm: {
      provider: resolution.modelMeta.provider,
      model: resolution.usedAttempt.userModelId,
      canonical: resolution.modelMeta.canonical,
      maxCompletionTokens: resolution.maxOutputTokensForCall,
    },
  };
}
