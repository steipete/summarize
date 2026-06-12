import { executeSummarize } from "../application/execute-summarize.js";
import type { PreparedSummarizeExecution } from "../application/execution-resources.js";
import type {
  AssetExecutionInput,
  SummarizeRequest,
  SummarizeResult,
  SummarizeRuntime,
} from "../application/summarize-contracts.js";
import type { CliInputProgress } from "./cli-input-progress.js";
import { presentCliSummarizeResult } from "./cli-summarize-output.js";
import { presentMediaFileResult } from "./flows/asset/media.js";
import { outputExtractedAsset } from "./flows/asset/output.js";
import { presentAssetSummary } from "./flows/asset/summary.js";
import type { AssetSummaryContext, PresentAssetSummaryArgs } from "./flows/asset/types.js";

function toPresentAssetSummaryArgs(input: AssetExecutionInput): PresentAssetSummaryArgs {
  return {
    sourceKind: input.sourceKind,
    sourceLabel: input.source,
    attachment: {
      kind: input.mediaType.startsWith("image/") ? "image" : "file",
      mediaType: input.mediaType,
      filename: input.filename,
    },
  };
}

function toDelegatedAssetSummaryArgs(
  result: Extract<SummarizeResult, { kind: "summary" }>,
): PresentAssetSummaryArgs {
  if (result.details.kind !== "delegated-asset") {
    throw new Error("CLI delegated asset presentation requires delegated asset details");
  }
  const { extracted } = result.details.summary;
  return {
    sourceKind: "asset-url",
    sourceLabel: extracted.source,
    attachment: {
      kind: extracted.mediaType.startsWith("image/") ? "image" : "file",
      mediaType: extracted.mediaType,
      filename: extracted.filename,
    },
  };
}

export function createCliSummarizeExecutor(options: {
  request: SummarizeRequest;
  runtime: SummarizeRuntime;
  prepared: PreparedSummarizeExecution;
  presentationContext: AssetSummaryContext;
  progress: CliInputProgress;
  extractionOutputContext: Omit<
    Parameters<typeof outputExtractedAsset>[0],
    "url" | "sourceLabel" | "attachment" | "extracted" | "elapsedMs" | "report" | "costUsd"
  >;
}): () => Promise<SummarizeResult> {
  const present = async (result: SummarizeResult) => {
    if (result.kind === "asset-summary") {
      await presentAssetSummary(
        options.presentationContext,
        toPresentAssetSummaryArgs(result.input),
        result.details,
      );
      return;
    }
    if (result.kind === "asset-extraction") {
      await outputExtractedAsset({
        ...options.extractionOutputContext,
        url: result.input.source,
        sourceLabel: result.input.source,
        attachment: result.input,
        extracted: result.extracted,
        elapsedMs: result.elapsedMs,
        report: result.report,
        costUsd: result.costUsd,
      });
      return;
    }
    if (result.kind === "asset-media") {
      await presentMediaFileResult(options.presentationContext, result.details);
      return;
    }
    if (result.kind === "summary" && result.details.kind === "delegated-asset") {
      await presentAssetSummary(
        options.presentationContext,
        toDelegatedAssetSummaryArgs(result),
        result.details.summary,
      );
      return;
    }
    await presentCliSummarizeResult({
      ctx: options.prepared.urlFlowContext,
      result,
    });
  };

  return async () => {
    try {
      const result = await executeSummarize(
        options.request,
        options.runtime,
        options.progress.handleEvent,
        options.prepared,
      );
      await present(result);
      return result;
    } finally {
      options.progress.stop();
    }
  };
}
