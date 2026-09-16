import { isYouTubeUrl } from "@steipete/summarize-core/content/url";
import type { ExtractedLinkContent } from "../content/index.js";
import { buildUrlPrompt } from "../engine/web-prompt.js";
import { resolveUrlSummaryExecution, type UrlSummaryResolution } from "../engine/web-summary.js";
import { CliError } from "../locale.js";
import type { UrlFlowContext } from "../run/flows/url/types.js";
import { createAcquiredAssetExecutor } from "./asset-execution.js";
import {
  readLastSuccessfulCliProvider,
  writeLastSuccessfulCliProvider,
} from "./cli-fallback-state.js";
import { prepareExecutionInput } from "./execution-input.js";
import {
  bindSummarizeExecutionEvents,
  type PreparedSummarizeExecution,
} from "./execution-resources.js";
import type {
  ExtractionResult,
  SummarizeEvent,
  SummarizeEventInput,
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
import { executeUrlWithAssetFallback, resolveInitialUrlInput } from "./url-routing.js";
import { createSummarizeRuntimeResources } from "./url-runtime.js";

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

function toEventInput(input: SummarizeRequest["input"]): SummarizeEventInput {
  if (input.kind === "resolved-asset" || input.kind === "resolved-media") {
    return {
      kind: input.kind,
      sourceKind: input.sourceKind,
      sourceLabel: input.sourceLabel,
      mediaType: input.attachment.mediaType,
      filename: input.attachment.filename,
    };
  }
  return input;
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
  let cleanupStdin: (() => Promise<void>) | null = null;

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
    input: toEventInput(request.input),
  });

  try {
    const preparedInput = await prepareExecutionInput({ request, runtime, emit });
    cleanupStdin = preparedInput.cleanup;
    let executionInput = preparedInput.input;
    const executionRequest =
      executionInput === request.input ? request : { ...request, input: executionInput };
    const boundPrepared = prepared
      ? bindSummarizeExecutionEvents(prepared, emit)
      : createSummarizeRuntimeResources({
          request: executionRequest,
          runtime,
          runStartedAtMs: startedAt,
          emit,
        });
    const assetExecutor = createAcquiredAssetExecutor({
      request,
      context: boundPrepared.assetSummaryContext,
      emit,
      emitSummary: (summary) => emitNormalizedSummary(summary, emit),
      elapsedMs: () => now() - startedAt,
      getSelectedModel: () => usedModel,
    });

    const routedInput = await resolveInitialUrlInput({
      input: executionInput,
      request,
      isYoutubeUrl:
        executionInput.kind === "input-url"
          ? (prepared?.isYoutubeUrl ?? isYouTubeUrl(executionInput.url))
          : false,
      ctx: boundPrepared.urlFlowContext,
      assetExecutor,
      emit,
    });
    executionInput = routedInput.input;
    const rawUrlInput = routedInput.rawUrlInput;

    if (executionInput.kind === "resolved-media" || executionInput.kind === "resolved-asset") {
      return await assetExecutor.execute(executionInput);
    }

    if (request.extractOnly && executionInput.kind !== "url") {
      throw new CliError("error.extractUrlRequired");
    }

    const ctx = boundPrepared.urlFlowContext;

    if (executionInput.kind === "visible-page") {
      const visiblePageResult = await executeVisiblePageSummary({
        ctx,
        input: executionInput,
        cacheMode: runtime.cache.mode,
      });
      extracted = visiblePageResult.extracted;
      normalizedSummary = emitResolvedSummary({
        resolution: visiblePageResult.resolution,
        extracted,
        emit,
      });
    } else {
      emit({ type: "extraction-started", url: executionInput.url });
      const isYoutubeUrl = prepared?.isYoutubeUrl ?? isYouTubeUrl(executionInput.url);
      const urlResult = await executeUrlWithAssetFallback({
        input: executionInput,
        rawUrlInput,
        request,
        isYoutubeUrl,
        ctx,
        assetExecutor,
        emit,
      });
      if (
        urlResult.kind === "asset-media" ||
        urlResult.kind === "asset-summary" ||
        urlResult.kind === "asset-extraction"
      ) {
        return urlResult;
      }
      extracted = urlResult.extracted;
      if (!slides) slides = urlResult.slides;
      if (!request.extractOnly) {
        if (urlResult.kind === "extraction") {
          throw new CliError("error.executionState", { kind: "extractionResult" });
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
            summary: urlResult.summary,
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
      throw new CliError("error.executionState", { kind: "content" });
    }

    if (request.extractOnly) {
      if (!extractionDetails) {
        throw new CliError("error.executionState", { kind: "details" });
      }
      const result: ExtractionResult = {
        kind: "extraction",
        input: executionInput as Extract<SummarizeRequest["input"], { kind: "url" }>,
        extracted,
        slides,
        details: extractionDetails,
      };
      emit({ type: "run-completed", result });
      return result;
    }

    const result: SummaryResult = {
      kind: "summary",
      input: executionInput,
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
  } finally {
    await cleanupStdin?.();
  }
}
