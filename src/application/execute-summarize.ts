import { isYouTubeUrl } from "../content/index.js";
import type { ExtractedLinkContent } from "../content/index.js";
import { buildUrlPrompt } from "../engine/web-prompt.js";
import { resolveUrlSummaryExecution, type UrlSummaryResolution } from "../engine/web-summary.js";
import { extractAssetContent } from "../run/flows/asset/extract.js";
import { executeAssetSummary } from "../run/flows/asset/summary.js";
import { executeUrlFlow } from "../run/flows/url/flow.js";
import type { UrlFlowContext } from "../run/flows/url/types.js";
import {
  readLastSuccessfulCliProvider,
  writeLastSuccessfulCliProvider,
} from "./cli-fallback-state.js";
import {
  bindSummarizeExecutionEvents,
  type PreparedSummarizeExecution,
} from "./execution-resources.js";
import type {
  AssetExecutionInput,
  AssetExtractionExecutionResult,
  AssetSummaryExecutionResult,
  ExtractionResult,
  SummarizeEvent,
  SummarizeEventSink,
  SummarizeRequest,
  SummarizeResult,
  SummarizeRuntime,
  SummaryResult,
} from "./summarize-contracts.js";
import {
  toUrlSummaryPresentationResolution,
  type SummarizeExecutionDetails,
  type SummarizeExtractionDetails,
} from "./url-result.js";
import { createSummarizeUrlFlowContext } from "./url-runtime.js";

const ignoreEvent: SummarizeEventSink = () => {};

function createVisiblePageContent(
  input: Extract<SummarizeRequest["input"], { kind: "visible-page" }>,
  cacheMode: SummarizeRuntime["cache"]["mode"],
): ExtractedLinkContent {
  let siteName: string | null = null;
  try {
    siteName = new URL(input.url).hostname || null;
  } catch {
    siteName = null;
  }

  return {
    url: input.url,
    title: input.title,
    description: null,
    siteName,
    content: input.text,
    truncated: input.truncated,
    totalCharacters: input.text.length,
    wordCount: input.text.trim() ? input.text.trim().split(/\s+/).length : 0,
    transcriptCharacters: null,
    transcriptLines: null,
    transcriptWordCount: null,
    transcriptSource: null,
    transcriptionProvider: null,
    transcriptMetadata: null,
    transcriptSegments: null,
    transcriptTimedText: null,
    mediaDurationSeconds: null,
    video: null,
    isVideoOnly: false,
    diagnostics: {
      strategy: "html",
      firecrawl: {
        attempted: false,
        used: false,
        cacheMode,
        cacheStatus: "unknown",
      },
      markdown: {
        requested: false,
        used: false,
        provider: null,
      },
      transcript: {
        cacheMode,
        cacheStatus: "unknown",
        textProvided: false,
        provider: null,
        attemptedProviders: [],
      },
    },
  };
}

async function executeVisiblePageSummary({
  ctx,
  input,
  cacheMode,
}: {
  ctx: UrlFlowContext;
  input: Extract<SummarizeRequest["input"], { kind: "visible-page" }>;
  cacheMode: SummarizeRuntime["cache"]["mode"];
}): Promise<{ extracted: ExtractedLinkContent; resolution: UrlSummaryResolution }> {
  const extracted = createVisiblePageContent(input, cacheMode);
  ctx.hooks.onExtracted?.(extracted);

  const prompt = buildUrlPrompt({
    extracted,
    outputLanguage: ctx.flags.outputLanguage,
    lengthArg: ctx.flags.lengthArg,
    promptOverride: ctx.flags.promptOverride ?? null,
    lengthInstruction: ctx.flags.lengthInstruction ?? null,
    languageInstruction: ctx.flags.languageInstruction ?? null,
  });

  const resolution = await resolveUrlSummaryExecution({
    ctx,
    url: input.url,
    extracted,
    prompt,
    onModelChosen: ctx.hooks.onModelChosen ?? null,
    runtime: {
      trace: (name, detail) => ctx.perfTrace?.mark(name, detail),
      onSummaryCached: ctx.hooks.onSummaryCached ?? null,
      readLastSuccessfulCliProvider: () => readLastSuccessfulCliProvider(ctx.io.envForRun),
      rememberCliProvider: (provider) =>
        writeLastSuccessfulCliProvider({ env: ctx.io.envForRun, provider }),
    },
  });
  return { extracted, resolution };
}

function emitResolvedSummary({
  resolution,
  extracted,
  emit,
}: {
  resolution: UrlSummaryResolution;
  extracted: ExtractedLinkContent;
  emit: SummarizeEventSink;
}): string {
  if (resolution.kind === "use-extracted") {
    emit({ type: "summary-delta", text: `${extracted.content}\n` });
    return extracted.content;
  }
  if (!resolution.summaryEmitted) {
    const normalized = resolution.normalizedSummary.replace(/^\n+/, "");
    emit({
      type: "summary-delta",
      text: normalized.endsWith("\n") ? normalized : `${normalized}\n`,
    });
  }
  return resolution.normalizedSummary;
}

function emitNormalizedSummary(summary: string, emit: SummarizeEventSink) {
  const normalized = summary.replace(/^\n+/, "");
  emit({
    type: "summary-delta",
    text: normalized.endsWith("\n") ? normalized : `${normalized}\n`,
  });
}

function toAssetExecutionInput(
  input: Extract<SummarizeRequest["input"], { kind: "resolved-asset" }>,
): AssetExecutionInput {
  return {
    kind: "asset",
    sourceKind: input.sourceKind,
    source: input.sourceLabel,
    mediaType: input.attachment.mediaType,
    filename: input.attachment.filename,
  };
}

export async function executeSummarize(
  request: SummarizeRequest,
  runtime: SummarizeRuntime,
  events: SummarizeEventSink = ignoreEvent,
  prepared: PreparedSummarizeExecution | null = null,
): Promise<SummarizeResult> {
  const now = runtime.now ?? Date.now;
  const startedAt = now();
  let usedModel: string | null = null;
  let summaryFromCache = false;
  let summaryText = "";
  let normalizedSummary: string | null = null;
  let extracted: ExtractedLinkContent | null = null;
  let slides: ExtractionResult["slides"] = null;
  let summaryDetails: SummarizeExecutionDetails = { kind: "visible-page" };
  let extractionDetails: SummarizeExtractionDetails | null = null;

  const emit = (event: SummarizeEvent) => {
    if (event.type === "model-selected") {
      usedModel = event.modelId;
    } else if (event.type === "summary-cache") {
      summaryFromCache = event.cached;
    } else if (event.type === "content-extracted") {
      extracted = event.content;
    } else if (event.type === "slides-extracted") {
      slides = event.slides;
    } else if (event.type === "summary-delta") {
      summaryText += event.text;
    }
    events(event);
    if (event.type === "content-extracted" && !request.extractOnly) {
      events({ type: "summary-started" });
    }
  };

  emit({
    type: "run-started",
    runId: runtime.runId,
    input:
      request.input.kind === "resolved-asset"
        ? {
            kind: "resolved-asset",
            sourceKind: request.input.sourceKind,
            sourceLabel: request.input.sourceLabel,
            mediaType: request.input.attachment.mediaType,
            filename: request.input.attachment.filename,
          }
        : request.input,
  });

  try {
    const boundPrepared = prepared ? bindSummarizeExecutionEvents(prepared, emit) : null;
    if (request.input.kind === "resolved-asset") {
      const assetSummaryContext = boundPrepared?.assetSummaryContext;
      if (!assetSummaryContext) {
        throw new Error("Resolved asset execution requires prepared asset resources");
      }
      if (request.extractOnly) {
        const extractedAsset = await extractAssetContent({
          ctx: {
            env: assetSummaryContext.env,
            envForRun: assetSummaryContext.envForRun,
            execFileImpl: assetSummaryContext.execFileImpl,
            timeoutMs: assetSummaryContext.timeoutMs,
            preprocessMode: assetSummaryContext.preprocessMode,
          },
          attachment: request.input.attachment,
        });
        const report = assetSummaryContext.shouldComputeReport
          ? await assetSummaryContext.buildReport()
          : null;
        const result: AssetExtractionExecutionResult = {
          kind: "asset-extraction",
          input: toAssetExecutionInput(request.input),
          extracted: extractedAsset,
          elapsedMs: now() - startedAt,
          report,
          costUsd:
            assetSummaryContext.metricsEnabled && report
              ? await assetSummaryContext.estimateCostUsd()
              : null,
        };
        emit({ type: "run-completed", result });
        return result;
      }
      emit({ type: "summary-started" });
      const assetResult = await executeAssetSummary(assetSummaryContext, {
        sourceKind: request.input.sourceKind,
        sourceLabel: request.input.sourceLabel,
        attachment: request.input.attachment,
        onModelChosen: (modelId) => emit({ type: "model-selected", modelId }),
      });
      if (!assetResult.summaryEmitted) {
        emitNormalizedSummary(assetResult.summary, emit);
      }
      const result: AssetSummaryExecutionResult = {
        kind: "asset-summary",
        input: toAssetExecutionInput(request.input),
        summary: assetResult.summary,
        usedModel: usedModel ?? assetResult.llm?.model ?? null,
        summaryFromCache: assetResult.summaryFromCache,
        elapsedMs: now() - startedAt,
        report: await assetSummaryContext.buildReport(),
        costUsd: await assetSummaryContext.estimateCostUsd(),
        details: assetResult,
      };
      emit({ type: "run-completed", result });
      return result;
    }

    if (request.extractOnly && request.input.kind !== "url") {
      throw new Error("Extract-only execution requires a URL input");
    }

    const ctx = boundPrepared
      ? boundPrepared.urlFlowContext
      : createSummarizeUrlFlowContext({
          request,
          runtime,
          runStartedAtMs: startedAt,
          emit,
        });

    if (request.input.kind === "visible-page") {
      const visiblePageResult = await executeVisiblePageSummary({
        ctx,
        input: request.input,
        cacheMode: runtime.cache.mode,
      });
      extracted = visiblePageResult.extracted;
      normalizedSummary = emitResolvedSummary({
        resolution: visiblePageResult.resolution,
        extracted,
        emit,
      });
    } else {
      emit({ type: "extraction-started", url: request.input.url });
      const urlResult = await executeUrlFlow({
        ctx,
        url: request.input.url,
        isYoutubeUrl: prepared?.isYoutubeUrl ?? isYouTubeUrl(request.input.url),
      });
      extracted = urlResult.extracted;
      if (!slides) slides = urlResult.slides;
      if (!request.extractOnly) {
        if (urlResult.kind === "extraction") {
          throw new Error("Internal error: summary execution returned extraction result");
        }
        if (urlResult.kind === "summary") {
          summaryDetails = {
            kind: "url-summary",
            prompt: urlResult.prompt,
            effectiveMarkdownMode: urlResult.effectiveMarkdownMode,
            resolution: toUrlSummaryPresentationResolution(urlResult.resolution),
          };
          normalizedSummary = emitResolvedSummary({
            resolution: urlResult.resolution,
            extracted,
            emit,
          });
        } else {
          summaryDetails = {
            kind: "delegated-asset",
            summaryEmitted: urlResult.summary.summaryEmitted,
          };
          normalizedSummary = urlResult.summary.summary;
          if (!urlResult.summary.summaryEmitted) {
            emitNormalizedSummary(normalizedSummary, emit);
          }
        }
      } else if (urlResult.kind === "extraction") {
        extractionDetails = {
          kind: "url-extraction",
          prompt: urlResult.prompt,
          effectiveMarkdownMode: urlResult.effectiveMarkdownMode,
        };
      }
    }

    if (!extracted) {
      throw new Error("Internal error: missing extracted content");
    }

    if (request.extractOnly) {
      if (!extractionDetails) {
        throw new Error("Internal error: missing extraction details");
      }
      const result: ExtractionResult = {
        kind: "extraction",
        input: request.input as Extract<SummarizeRequest["input"], { kind: "url" }>,
        extracted,
        slides,
        details: extractionDetails,
      };
      emit({ type: "run-completed", result });
      return result;
    }

    const result: SummaryResult = {
      kind: "summary",
      input: request.input,
      summary: normalizedSummary ?? summaryText.replace(/\n$/, ""),
      usedModel: usedModel ?? ctx.model.requestedModelLabel,
      extracted,
      slides,
      summaryFromCache,
      elapsedMs: now() - startedAt,
      report: await ctx.hooks.buildReport(),
      costUsd: await ctx.hooks.estimateCostUsd(),
      details: summaryDetails,
    };
    emit({ type: "run-completed", result });
    return result;
  } catch (error) {
    emit({ type: "run-failed", error: error instanceof Error ? error.message : String(error) });
    throw error;
  }
}
