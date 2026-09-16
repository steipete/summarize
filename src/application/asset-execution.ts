import { CliError } from "../locale.js";
import { extractAssetContent } from "../run/flows/asset/extract.js";
import { executeMediaFile } from "../run/flows/asset/media.js";
import { executeAssetSummary } from "../run/flows/asset/summary.js";
import type { AssetSummaryContext } from "../run/flows/asset/types.js";
import type { AcquiredAssetInput } from "./input-acquisition.js";
import type {
  AssetExecutionInput,
  AssetExtractionExecutionResult,
  AssetMediaExecutionResult,
  AssetSummaryExecutionResult,
  SummarizeEventSink,
  SummarizeRequest,
} from "./summarize-contracts.js";

type ResolvedAssetInput = Extract<
  SummarizeRequest["input"],
  { kind: "resolved-asset" | "resolved-media" }
>;

export type AcquiredAssetExecutionResult =
  | AssetMediaExecutionResult
  | AssetSummaryExecutionResult
  | AssetExtractionExecutionResult;

export type AcquiredAssetExecutor = {
  execute: (input: ResolvedAssetInput) => Promise<AcquiredAssetExecutionResult>;
  emitProgress: (input: AcquiredAssetInput) => void;
};

type AcquiredAssetExecutorOptions = {
  request: SummarizeRequest;
  context: AssetSummaryContext | null | undefined;
  emit: SummarizeEventSink;
  emitSummary: (summary: string) => void;
  elapsedMs: () => number;
  getSelectedModel: () => string | null;
};

function toAssetExecutionInput(input: ResolvedAssetInput): AssetExecutionInput {
  return {
    kind: "asset",
    sourceKind: input.sourceKind,
    source: input.sourceLabel,
    mediaType: input.attachment.mediaType,
    filename: input.attachment.filename,
  };
}

async function executeResolvedMedia(
  input: Extract<ResolvedAssetInput, { kind: "resolved-media" }>,
  options: AcquiredAssetExecutorOptions & { context: AssetSummaryContext },
): Promise<AssetMediaExecutionResult> {
  if (!options.request.extractOnly) {
    options.emit({ type: "summary-started" });
  }
  const mediaResult = await executeMediaFile(options.context, {
    sourceKind: input.sourceKind,
    sourceLabel: input.sourceLabel,
    attachment: input.attachment,
    onModelChosen: (modelId) => options.emit({ type: "model-selected", modelId }),
  });
  if (mediaResult.kind === "summary" && !mediaResult.summary.summaryEmitted) {
    options.emitSummary(mediaResult.summary.summary);
  }
  const report = mediaResult.kind === "summary" ? await options.context.buildReport() : null;
  const result: AssetMediaExecutionResult = {
    kind: "asset-media",
    input: toAssetExecutionInput(input),
    usedModel:
      options.getSelectedModel() ??
      (mediaResult.kind === "summary" ? (mediaResult.summary.llm?.model ?? null) : null),
    summaryFromCache: mediaResult.kind === "summary" ? mediaResult.summary.summaryFromCache : false,
    elapsedMs: options.elapsedMs(),
    report,
    costUsd: mediaResult.kind === "summary" ? await options.context.estimateCostUsd() : null,
    details: mediaResult,
  };
  options.emit({ type: "run-completed", result });
  return result;
}

async function executeResolvedAsset(
  input: Extract<ResolvedAssetInput, { kind: "resolved-asset" }>,
  options: AcquiredAssetExecutorOptions & { context: AssetSummaryContext },
): Promise<AssetSummaryExecutionResult | AssetExtractionExecutionResult> {
  if (options.request.extractOnly) {
    const maxCharacters =
      options.request.input.kind === "url" || options.request.input.kind === "input-url"
        ? options.request.input.maxCharacters
        : null;
    const extractedAsset = await extractAssetContent({
      ctx: {
        env: options.context.env,
        envForRun: options.context.envForRun,
        execFileImpl: options.context.execFileImpl,
        timeoutMs: options.context.timeoutMs,
        preprocessMode: options.context.preprocessMode,
      },
      attachment: input.attachment,
      ...(typeof maxCharacters === "number" ? { maxCharacters } : {}),
    });
    const report = options.context.shouldComputeReport ? await options.context.buildReport() : null;
    const result: AssetExtractionExecutionResult = {
      kind: "asset-extraction",
      input: toAssetExecutionInput(input),
      extracted: extractedAsset,
      elapsedMs: options.elapsedMs(),
      report,
      costUsd:
        options.context.metricsEnabled && report ? await options.context.estimateCostUsd() : null,
    };
    options.emit({ type: "run-completed", result });
    return result;
  }

  options.emit({ type: "summary-started" });
  const assetResult = await executeAssetSummary(options.context, {
    sourceKind: input.sourceKind,
    sourceLabel: input.sourceLabel,
    attachment: input.attachment,
    onModelChosen: (modelId) => options.emit({ type: "model-selected", modelId }),
  });
  if (!assetResult.summaryEmitted) {
    options.emitSummary(assetResult.summary);
  }
  const result: AssetSummaryExecutionResult = {
    kind: "asset-summary",
    input: toAssetExecutionInput(input),
    summary: assetResult.summary,
    usedModel: options.getSelectedModel() ?? assetResult.llm?.model ?? null,
    summaryFromCache: assetResult.summaryFromCache,
    elapsedMs: options.elapsedMs(),
    report: await options.context.buildReport(),
    costUsd: await options.context.estimateCostUsd(),
    details: assetResult,
  };
  options.emit({ type: "run-completed", result });
  return result;
}

export function createAcquiredAssetExecutor(
  options: AcquiredAssetExecutorOptions,
): AcquiredAssetExecutor {
  const execute = async (input: ResolvedAssetInput): Promise<AcquiredAssetExecutionResult> => {
    const context = options.context;
    if (!context) {
      throw new CliError("error.assetResourcesMissing", {
        kind: input.kind === "resolved-media" ? "media" : "asset",
      });
    }
    const executionOptions = { ...options, context };
    return input.kind === "resolved-media"
      ? await executeResolvedMedia(input, executionOptions)
      : await executeResolvedAsset(input, executionOptions);
  };

  const emitProgress = (input: AcquiredAssetInput) => {
    options.emit({
      type: "input-progress",
      phase:
        input.kind === "resolved-media"
          ? "transcribing"
          : options.request.extractOnly
            ? "extracting"
            : "summarizing",
      source: input.sourceLabel,
      filename: input.attachment.filename,
      mediaType: input.attachment.mediaType,
      sizeBytes: input.sizeBytes,
    });
  };

  return { execute, emitProgress };
}
