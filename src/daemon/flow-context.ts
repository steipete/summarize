import { Writable } from "node:stream";
import type { CacheState } from "../cache.js";
import type { SummarizeConfig } from "../config.js";
import type {
  ExtractedLinkContent,
  LinkPreviewProgressEvent,
  MediaCache,
} from "../content/index.js";
import type { ExecFileFn } from "../markitdown.js";
import type { FixedModelSpec } from "../model-spec.js";
import type { AssetSummaryContext, SummarizeAssetArgs } from "../run/flows/asset/summary.js";
import type { UrlFlowContext } from "../run/flows/url/types.js";
import type { SlideImage, SlideSettings, SlideSourceKind } from "../slides/index.js";
import { execFileTracked } from "../processes.js";
import { summarizeAsset as summarizeAssetFlow } from "../run/flows/asset/summary.js";
import { resolveRunContextState } from "../run/run-context.js";
import { createRunMetrics } from "../run/run-metrics.js";
import { resolveModelSelection } from "../run/run-models.js";
import { resolveDesiredOutputTokens } from "../run/run-output.js";
import {
  type RunOverrides,
  resolveOutputLanguageSetting,
  resolveSummaryLength,
} from "../run/run-settings.js";
import { createSummaryEngine } from "../run/summary-engine.js";

type TextSink = {
  writeChunk: (text: string) => void;
};

function createWritableFromTextSink(sink: TextSink): NodeJS.WritableStream {
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      const text =
        typeof chunk === "string" ? chunk : Buffer.isBuffer(chunk) ? chunk.toString("utf8") : "";
      if (text) sink.writeChunk(text);
      callback();
    },
  });
  (stream as unknown as { isTTY?: boolean }).isTTY = false;
  return stream;
}

function applyAutoCliFallbackOverrides(
  config: SummarizeConfig | null,
  overrides: RunOverrides,
): SummarizeConfig | null {
  const hasOverride = overrides.autoCliFallbackEnabled !== null || overrides.autoCliOrder !== null;
  if (!hasOverride) return config;
  const current = config ?? {};
  const currentCli = current.cli ?? {};
  const currentAutoFallback = currentCli.autoFallback ?? currentCli.magicAuto ?? {};
  return {
    ...current,
    cli: {
      ...currentCli,
      autoFallback: {
        ...currentAutoFallback,
        ...(typeof overrides.autoCliFallbackEnabled === "boolean"
          ? { enabled: overrides.autoCliFallbackEnabled }
          : {}),
        ...(Array.isArray(overrides.autoCliOrder) ? { order: overrides.autoCliOrder } : {}),
      },
    },
  };
}

export type DaemonUrlFlowContextArgs = {
  env: Record<string, string | undefined>;
  fetchImpl: typeof fetch;
  cache: CacheState;
  mediaCache?: MediaCache | null;
  modelOverride: string | null;
  promptOverride: string | null;
  lengthRaw: unknown;
  languageRaw: unknown;
  maxExtractCharacters: number | null;
  format?: "text" | "markdown";
  overrides?: RunOverrides | null;
  extractOnly?: boolean;
  slides?: SlideSettings | null;
  hooks?: {
    onModelChosen?: ((modelId: string) => void) | null;
    onExtracted?: ((extracted: ExtractedLinkContent) => void) | null;
    onSlidesExtracted?:
      | ((
          slides: Awaited<ReturnType<typeof import("../slides/index.js").extractSlidesForSource>>,
        ) => void)
      | null;
    onSlidesProgress?: ((text: string) => void) | null;
    onSlidesDone?: ((result: { ok: boolean; error?: string | null }) => void) | null;
    onSlideChunk?: (chunk: {
      slide: SlideImage;
      meta: {
        slidesDir: string;
        sourceUrl: string;
        sourceId: string;
        sourceKind: SlideSourceKind;
        ocrAvailable: boolean;
      };
    }) => void;
    onLinkPreviewProgress?: ((event: LinkPreviewProgressEvent) => void) | null;
    onSummaryCached?: ((cached: boolean) => void) | null;
  } | null;
  runStartedAtMs: number;
  stdoutSink: TextSink;
};

export function createDaemonUrlFlowContext(args: DaemonUrlFlowContextArgs): UrlFlowContext {
  const {
    env,
    fetchImpl,
    cache,
    mediaCache = null,
    modelOverride,
    promptOverride,
    lengthRaw,
    languageRaw,
    maxExtractCharacters,
    format,
    overrides,
    extractOnly,
    slides,
    hooks,
    runStartedAtMs,
    stdoutSink,
  } = args;

  const envForRun: Record<string, string | undefined> = { ...env };

  const languageExplicitlySet = typeof languageRaw === "string" && Boolean(languageRaw.trim());

  const { lengthArg } = resolveSummaryLength(lengthRaw);
  const resolvedOverrides: RunOverrides = overrides ?? {
    firecrawlMode: null,
    markdownMode: null,
    preprocessMode: null,
    youtubeMode: null,
    videoMode: null,
    transcriptTimestamps: null,
    forceSummary: null,
    timeoutMs: null,
    retries: null,
    maxOutputTokensArg: null,
    transcriber: null,
    autoCliFallbackEnabled: null,
    autoCliOrder: null,
  };
  if (resolvedOverrides.transcriber) {
    envForRun.SUMMARIZE_TRANSCRIBER = resolvedOverrides.transcriber;
  }
  const videoModeOverride = resolvedOverrides.videoMode;
  const resolvedFormat = format === "markdown" ? "markdown" : "text";

  const {
    config,
    configPath,
    outputLanguage: outputLanguageFromConfig,
    openaiWhisperUsdPerMinute,
    videoMode,
    cliConfigForRun,
    configForCli,
    openaiUseChatCompletions,
    configModelLabel,
    apiKey,
    openrouterApiKey,
    openrouterConfigured,
    groqApiKey,
    openaiTranscriptionKey,
    xaiApiKey,
    googleApiKey,
    anthropicApiKey,
    zaiApiKey,
    zaiBaseUrl,
    nvidiaApiKey,
    nvidiaBaseUrl,
    providerBaseUrls,
    firecrawlApiKey,
    firecrawlConfigured,
    googleConfigured,
    anthropicConfigured,
    vertexConfig,
    cliAvailability,
    envForAuto,
    apifyToken,
    ytDlpPath,
    ytDlpCookiesFromBrowser,
    falApiKey,
  } = resolveRunContextState({
    env: envForRun,
    envForRun,
    programOpts: { videoMode: videoModeOverride ?? "auto" },
    languageExplicitlySet,
    videoModeExplicitlySet: videoModeOverride != null,
    cliFlagPresent: false,
    cliProviderArg: null,
  });
  const configForCliWithMagic = applyAutoCliFallbackOverrides(configForCli, resolvedOverrides);
  const allowAutoCliFallback = resolvedOverrides.autoCliFallbackEnabled === true;

  const {
    requestedModel,
    requestedModelInput,
    requestedModelLabel,
    isNamedModelSelection,
    isImplicitAutoSelection,
    wantsFreeNamedModel,
    configForModelSelection,
    isFallbackModel,
  } = resolveModelSelection({
    config,
    configForCli: configForCliWithMagic,
    configPath,
    envForRun,
    explicitModelArg: modelOverride?.trim() ? modelOverride.trim() : null,
  });

  const fixedModelSpec: FixedModelSpec | null =
    requestedModel.kind === "fixed" ? requestedModel : null;
  const maxOutputTokensArg = resolvedOverrides.maxOutputTokensArg;
  const desiredOutputTokens = resolveDesiredOutputTokens({ lengthArg, maxOutputTokensArg });

  const metrics = createRunMetrics({ env: envForRun, fetchImpl, maxOutputTokensArg });

  const stdout = createWritableFromTextSink(stdoutSink);
  const stderr = process.stderr;

  const timeoutMs = resolvedOverrides.timeoutMs ?? 120_000;
  const retries = resolvedOverrides.retries ?? 1;
  const firecrawlMode = resolvedOverrides.firecrawlMode ?? "off";
  const markdownMode =
    resolvedOverrides.markdownMode ?? (resolvedFormat === "markdown" ? "readability" : "off");
  const preprocessMode = resolvedOverrides.preprocessMode ?? "auto";
  const youtubeMode = resolvedOverrides.youtubeMode ?? "auto";

  const summaryEngine = createSummaryEngine({
    env: envForRun,
    envForRun,
    stdout,
    stderr,
    execFileImpl: execFileTracked as unknown as ExecFileFn,
    timeoutMs,
    retries,
    streamingEnabled: true,
    streamingOutputMode: "delta",
    plain: true,
    verbose: false,
    verboseColor: false,
    openaiUseChatCompletions,
    cliConfigForRun: cliConfigForRun ?? null,
    cliAvailability,
    trackedFetch: metrics.trackedFetch,
    resolveMaxOutputTokensForCall: metrics.resolveMaxOutputTokensForCall,
    resolveMaxInputTokensForCall: metrics.resolveMaxInputTokensForCall,
    llmCalls: metrics.llmCalls,
    clearProgressForStdout: () => {},
    apiKeys: {
      xaiApiKey,
      openaiApiKey: apiKey,
      googleApiKey,
      anthropicApiKey,
      openrouterApiKey,
    },
    keyFlags: {
      googleConfigured,
      anthropicConfigured,
      openrouterConfigured,
    },
    zai: { apiKey: zaiApiKey, baseUrl: zaiBaseUrl },
    nvidia: { apiKey: nvidiaApiKey, baseUrl: nvidiaBaseUrl },
    providerBaseUrls,
    vertexConfig: vertexConfig ?? null,
  });

  const outputLanguage = resolveOutputLanguageSetting({
    raw: languageRaw,
    fallback: outputLanguageFromConfig,
  });

  const lengthInstruction =
    promptOverride && lengthArg.kind === "chars"
      ? `Output is ${lengthArg.maxCharacters.toLocaleString()} characters.`
      : null;
  const languageExplicit =
    typeof languageRaw === "string" &&
    languageRaw.trim().length > 0 &&
    languageRaw.trim().toLowerCase() !== "auto";
  const languageInstruction =
    promptOverride && languageExplicit && outputLanguage.kind === "fixed"
      ? `Output should be ${outputLanguage.label}.`
      : null;

  const assetSummaryContext: AssetSummaryContext = {
    env: envForRun,
    envForRun,
    stdout,
    stderr,
    execFileImpl: execFileTracked as unknown as ExecFileFn,
    timeoutMs,
    preprocessMode,
    format: "text",
    extractMode: extractOnly ?? false,
    lengthArg,
    forceSummary: resolvedOverrides.forceSummary ?? false,
    outputLanguage,
    videoMode,
    fixedModelSpec,
    promptOverride,
    lengthInstruction,
    languageInstruction,
    isFallbackModel,
    isImplicitAutoSelection,
    allowAutoCliFallback,
    desiredOutputTokens,
    envForAuto,
    configForModelSelection,
    cliAvailability,
    requestedModel,
    requestedModelInput,
    requestedModelLabel,
    wantsFreeNamedModel,
    isNamedModelSelection,
    maxOutputTokensArg,
    json: false,
    metricsEnabled: false,
    metricsDetailed: false,
    shouldComputeReport: false,
    runStartedAtMs,
    verbose: false,
    verboseColor: false,
    streamingEnabled: true,
    plain: true,
    summaryEngine,
    trackedFetch: metrics.trackedFetch,
    writeViaFooter: () => {},
    clearProgressForStdout: () => {},
    getLiteLlmCatalog: metrics.getLiteLlmCatalog,
    buildReport: metrics.buildReport,
    estimateCostUsd: metrics.estimateCostUsd,
    llmCalls: metrics.llmCalls,
    cache,
    summaryCacheBypass: false,
    mediaCache,
    apiStatus: {
      xaiApiKey,
      apiKey,
      nvidiaApiKey,
      openrouterApiKey,
      apifyToken,
      firecrawlConfigured,
      googleConfigured,
      anthropicConfigured,
      providerBaseUrls,
      zaiApiKey,
      zaiBaseUrl,
      nvidiaBaseUrl,
    },
  };

  const ctx: UrlFlowContext = {
    io: {
      env: envForRun,
      envForRun,
      stdout,
      stderr,
      execFileImpl: execFileTracked as unknown as ExecFileFn,
      fetch: metrics.trackedFetch,
    },
    flags: {
      timeoutMs,
      maxExtractCharacters,
      retries,
      format: resolvedFormat,
      markdownMode,
      preprocessMode,
      youtubeMode,
      firecrawlMode,
      videoMode,
      transcriptTimestamps: resolvedOverrides.transcriptTimestamps ?? false,
      outputLanguage,
      lengthArg,
      forceSummary: resolvedOverrides.forceSummary ?? false,
      promptOverride,
      lengthInstruction,
      languageInstruction,
      summaryCacheBypass: false,
      maxOutputTokensArg,
      json: false,
      extractMode: extractOnly ?? false,
      metricsEnabled: false,
      metricsDetailed: false,
      shouldComputeReport: false,
      runStartedAtMs,
      verbose: false,
      verboseColor: false,
      progressEnabled: false,
      streamMode: "on",
      streamingEnabled: true,
      plain: true,
      configPath,
      configModelLabel,
      slides: slides ?? null,
      slidesDebug: false,
      slidesOutput: false,
    },
    model: {
      requestedModel,
      requestedModelInput,
      requestedModelLabel,
      fixedModelSpec,
      isFallbackModel,
      isImplicitAutoSelection,
      allowAutoCliFallback,
      isNamedModelSelection,
      wantsFreeNamedModel,
      desiredOutputTokens,
      configForModelSelection,
      envForAuto,
      cliAvailability,
      openaiUseChatCompletions,
      openaiWhisperUsdPerMinute,
      apiStatus: {
        xaiApiKey,
        apiKey,
        nvidiaApiKey,
        openrouterApiKey,
        openrouterConfigured,
        googleApiKey,
        googleConfigured,
        anthropicApiKey,
        anthropicConfigured,
        providerBaseUrls,
        zaiApiKey,
        zaiBaseUrl,
        nvidiaBaseUrl,
        firecrawlConfigured,
        firecrawlApiKey,
        apifyToken,
        ytDlpPath,
        ytDlpCookiesFromBrowser,
        falApiKey,
        groqApiKey,
        openaiTranscriptionKey,
      },
      summaryEngine,
      getLiteLlmCatalog: metrics.getLiteLlmCatalog,
      llmCalls: metrics.llmCalls,
    },
    cache,
    mediaCache,
    hooks: {
      onModelChosen: hooks?.onModelChosen ?? null,
      onExtracted: hooks?.onExtracted ?? null,
      onSlidesExtracted: hooks?.onSlidesExtracted ?? null,
      onSlidesProgress: hooks?.onSlidesProgress ?? null,
      onSlidesDone: hooks?.onSlidesDone ?? null,
      onSlideChunk: hooks?.onSlideChunk ?? undefined,
      onLinkPreviewProgress: hooks?.onLinkPreviewProgress ?? null,
      onSummaryCached: hooks?.onSummaryCached ?? null,
      setTranscriptionCost: metrics.setTranscriptionCost,
      summarizeAsset: (assetArgs: SummarizeAssetArgs) =>
        summarizeAssetFlow(assetSummaryContext, assetArgs),
      writeViaFooter: () => {},
      clearProgressForStdout: () => {},
      setClearProgressBeforeStdout: () => {},
      clearProgressIfCurrent: () => {},
      buildReport: metrics.buildReport,
      estimateCostUsd: metrics.estimateCostUsd,
    },
  };

  return ctx;
}
