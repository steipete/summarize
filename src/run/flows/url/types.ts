import type { SummaryLength } from "@steipete/summarize-core";
import type { ExecutableRunModel } from "../../../application/model-runtime.js";
import type { CacheState } from "../../../cache.js";
import type {
  ExtractedLinkContent,
  LinkPreviewProgressEvent,
  MediaCache,
} from "../../../content/index.js";
import type { RunMetricsReport } from "../../../costs.js";
import type { StreamMode } from "../../../flags.js";
import type { OutputLanguage } from "../../../language.js";
import type { CliProgressCallback } from "../../../locale.js";
import type { ExecFileFn } from "../../../markitdown.js";
import type {
  SlideExtractionResult,
  SlideImage,
  SlideSettings,
  SlideSourceKind,
} from "../../../slides/index.js";
import type { SpeakerIdentificationSettings } from "../../../speaker-identification/index.js";
import type { PerfTrace } from "../../perf-trace.js";
import type { AssetSummaryResult, SummarizeAssetArgs } from "../asset/types.js";

export type UrlFlowIo = {
  env: Record<string, string | undefined>;
  envForRun: Record<string, string | undefined>;
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
  execFileImpl: ExecFileFn;
  fetch: typeof fetch;
  urlFetch?: typeof fetch;
};

export type UrlFlowFlags = {
  timeoutMs: number;
  maxExtractCharacters?: number | null;
  retries: number;
  format: "text" | "markdown";
  markdownMode: "off" | "auto" | "llm" | "readability";
  preprocessMode: "off" | "auto" | "always";
  youtubeMode: "auto" | "web" | "yt-dlp" | "apify" | "no-auto";
  firecrawlMode: "off" | "auto" | "always";
  videoMode: "auto" | "transcript" | "understand";
  embeddedVideoMode: "auto" | "off" | "prefer" | "both";
  transcriptTimestamps: boolean;
  transcriptDiarization: "auto" | "elevenlabs" | "openai" | null;
  speakerIdentification: SpeakerIdentificationSettings | null;
  outputLanguage: OutputLanguage;
  lengthArg: { kind: "preset"; preset: SummaryLength } | { kind: "chars"; maxCharacters: number };
  forceSummary: boolean;
  promptOverride?: string | null;
  lengthInstruction?: string | null;
  languageInstruction?: string | null;
  summaryCacheBypass: boolean;
  maxOutputTokensArg: number | null;
  json: boolean;
  extractMode: boolean;
  metricsEnabled: boolean;
  metricsDetailed: boolean;
  shouldComputeReport: boolean;
  runStartedAtMs: number;
  verbose: boolean;
  verboseColor: boolean;
  progressEnabled: boolean;
  streamMode: StreamMode;
  streamingEnabled: boolean;
  plain: boolean;
  configPath: string | null;
  configModelLabel: string | null;
  slides: SlideSettings | null;
  slidesDebug: boolean;
  slidesOutput?: boolean;
  throwOnAssetLikeHtmlError?: boolean;
};

export type UrlFlowModel = ExecutableRunModel;

export type UrlFlowHooks = {
  onModelChosen?: ((modelId: string) => void) | null;
  onExtracted?: ((extracted: ExtractedLinkContent) => void) | null;
  onSlidesExtracted?: ((slides: SlideExtractionResult) => void) | null;
  onSlidesProgress?: CliProgressCallback | null;
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
  setTranscriptionCost: (costUsd: number | null, label: string | null) => void;
  summarizeAsset: (args: SummarizeAssetArgs) => Promise<AssetSummaryResult>;
  writeViaFooter: (parts: string[]) => void;
  clearProgressForStdout: () => void;
  restoreProgressAfterStdout?: (() => void) | null;
  setClearProgressBeforeStdout: (fn: (() => undefined | (() => void)) | null) => void;
  clearProgressIfCurrent: (fn: () => void) => void;
  buildReport: () => Promise<RunMetricsReport>;
  estimateCostUsd: () => Promise<number | null>;
};

export type UrlFlowEventHooks = Pick<
  UrlFlowHooks,
  | "onModelChosen"
  | "onExtracted"
  | "onSlidesExtracted"
  | "onSlidesProgress"
  | "onSlidesDone"
  | "onSlideChunk"
  | "onLinkPreviewProgress"
  | "onSummaryCached"
>;

export type UrlFlowRuntimeHooks = Pick<
  UrlFlowHooks,
  | "setTranscriptionCost"
  | "summarizeAsset"
  | "writeViaFooter"
  | "clearProgressForStdout"
  | "restoreProgressAfterStdout"
  | "setClearProgressBeforeStdout"
  | "clearProgressIfCurrent"
  | "buildReport"
  | "estimateCostUsd"
>;

export function createUrlFlowHooks(options: {
  runtime: UrlFlowRuntimeHooks;
  events?: Partial<UrlFlowEventHooks>;
}): UrlFlowHooks {
  return {
    onModelChosen: null,
    onExtracted: null,
    onSlidesExtracted: null,
    onSlidesProgress: null,
    onSlidesDone: null,
    onSlideChunk: undefined,
    onLinkPreviewProgress: null,
    onSummaryCached: null,
    ...options.events,
    ...options.runtime,
  };
}

export function composeUrlFlowHooks(
  base: UrlFlowHooks,
  overrides: Partial<UrlFlowHooks>,
): UrlFlowHooks {
  return {
    ...base,
    ...overrides,
  };
}

export function createUrlFlowContext(options: {
  io: UrlFlowIo;
  flags: UrlFlowFlags;
  model: UrlFlowModel;
  cache: CacheState;
  mediaCache: MediaCache | null;
  perfTrace?: PerfTrace | null;
  runtimeHooks: UrlFlowRuntimeHooks;
  eventHooks?: Partial<UrlFlowEventHooks>;
}): UrlFlowContext {
  const { io, flags, model, cache, mediaCache, perfTrace, runtimeHooks, eventHooks } = options;
  return {
    io,
    flags,
    model,
    cache,
    mediaCache,
    perfTrace: perfTrace ?? null,
    hooks: createUrlFlowHooks({ runtime: runtimeHooks, events: eventHooks }),
  };
}

/**
 * Wiring struct for `executeUrlFlow`.
 * CLI runner populates the full surface; daemon uses a smaller subset (no TTY/progress/footer),
 * but both share the same extraction/cache/model logic.
 */
export type UrlFlowContext = {
  io: UrlFlowIo;
  flags: UrlFlowFlags;
  model: UrlFlowModel;
  cache: CacheState;
  mediaCache: MediaCache | null;
  perfTrace?: PerfTrace | null;
  hooks: UrlFlowHooks;
};
