import type { SummaryLength } from "@steipete/summarize-core";
import type { CacheState } from "../../../cache.js";
import type { CliProvider, SummarizeConfig } from "../../../config.js";
import type { MediaCache } from "../../../content/index.js";
import type { LlmCall, RunMetricsReport } from "../../../costs.js";
import type { SummaryStreamHandler } from "../../../engine/events.js";
import type { createModelExecutor } from "../../../engine/model-executor.js";
import type { ModelMeta } from "../../../engine/types.js";
import type { OutputLanguage } from "../../../language.js";
import type { ExecFileFn } from "../../../markitdown.js";
import type { FixedModelSpec, RequestedModel } from "../../../model-spec.js";
import type { RunApiStatus } from "../../../shared/run-api-status.js";
import type { SpeakerIdentificationSettings } from "../../../speaker-identification/index.js";
import type { AssetAttachment } from "../../attachments.js";

export type AssetSummaryContext = {
  env: Record<string, string | undefined>;
  envForRun: Record<string, string | undefined>;
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
  execFileImpl: ExecFileFn;
  timeoutMs: number;
  preprocessMode: "off" | "auto" | "always";
  format: "text" | "markdown";
  extractMode: boolean;
  lengthArg: { kind: "preset"; preset: SummaryLength } | { kind: "chars"; maxCharacters: number };
  forceSummary: boolean;
  outputLanguage: OutputLanguage;
  videoMode: "auto" | "transcript" | "understand";
  transcriptTimestamps: boolean;
  transcriptDiarization: "auto" | "elevenlabs" | "openai" | null;
  speakerIdentification: SpeakerIdentificationSettings | null;
  configPath: string | null;
  fixedModelSpec: FixedModelSpec | null;
  promptOverride?: string | null;
  lengthInstruction?: string | null;
  languageInstruction?: string | null;
  isFallbackModel: boolean;
  isImplicitAutoSelection: boolean;
  allowAutoCliFallback: boolean;
  desiredOutputTokens: number | null;
  envForAuto: Record<string, string | undefined>;
  configForModelSelection: SummarizeConfig | null;
  cliAvailability: Partial<Record<CliProvider, boolean>>;
  requestedModel: RequestedModel;
  requestedModelInput: string;
  requestedModelLabel: string;
  wantsFreeNamedModel: boolean;
  isNamedModelSelection: boolean;
  maxOutputTokensArg: number | null;
  json: boolean;
  metricsEnabled: boolean;
  metricsDetailed: boolean;
  shouldComputeReport: boolean;
  runStartedAtMs: number;
  verbose: boolean;
  verboseColor: boolean;
  streamingEnabled: boolean;
  plain: boolean;
  summaryEngine: ReturnType<typeof createModelExecutor>;
  summaryStream: SummaryStreamHandler | null;
  onSummaryCached?: ((cached: boolean) => void) | null;
  trackedFetch: typeof fetch;
  writeViaFooter: (parts: string[]) => void;
  clearProgressForStdout: () => void;
  restoreProgressAfterStdout?: (() => void) | null;
  getLiteLlmCatalog: () => Promise<
    Awaited<ReturnType<typeof import("../../../pricing/litellm.js").loadLiteLlmCatalog>>["catalog"]
  >;
  buildReport: () => Promise<RunMetricsReport>;
  estimateCostUsd: () => Promise<number | null>;
  llmCalls: LlmCall[];
  cache: CacheState;
  summaryCacheBypass: boolean;
  mediaCache: MediaCache | null;
  apiStatus: RunApiStatus;
};

export type SummarizeAssetArgs = {
  sourceKind: "file" | "asset-url";
  sourceLabel: string;
  attachment: AssetAttachment;
  onModelChosen?: ((modelId: string) => void) | null;
};

export type PresentAssetSummaryArgs = {
  sourceKind: "file" | "asset-url";
  sourceLabel: string;
  attachment: Pick<AssetAttachment, "kind" | "mediaType" | "filename">;
};

export type AssetSummaryResult = {
  kind: "summary";
  outcome: "model" | "short-content" | "token-fit" | "attempts-exhausted";
  summary: string;
  summaryEmitted: boolean;
  summaryFromCache: boolean;
  prompt: string;
  extracted: {
    kind: "asset";
    source: string;
    mediaType: string;
    filename: string | null;
  };
  footerParts: string[];
  llm: {
    provider: ModelMeta["provider"];
    model: string;
    maxCompletionTokens: number | null;
    strategy: "single";
  } | null;
};
