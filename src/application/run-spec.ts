import type { SummarizeConfig } from "../config.js";
import type {
  DiarizationMode,
  EmbeddedVideoMode,
  FirecrawlMode,
  LengthArg,
  MarkdownMode,
  PreprocessMode,
  VideoMode,
  YoutubeMode,
} from "../flags.js";
import type { OutputLanguage } from "../language.js";
import type { RunOverrides } from "../run/run-settings.js";
import {
  buildPromptLengthInstruction,
  createEmptyRunOverrides,
  resolveOutputLanguageSetting,
  resolveSummaryLength,
} from "../run/run-settings.js";
import { createRunConfigInput, type RunConfigInput } from "./config-state.js";
import { resolveRunContextState, type RunContextState } from "./context.js";
import { resolveRunModelSpec, type RunModelSpec } from "./model-selection.js";
import type { SummarizeRequest } from "./summarize-contracts.js";

export type SummarizeRunInput = SummarizeRequest["input"];

export type SummarizeRunRequest = Omit<SummarizeRequest, "input"> & {
  input: SummarizeRunInput;
};

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

export type ResolvedSummarizeSpec = {
  format: "text" | "markdown";
  maxExtractCharacters: number | null;
  timeoutMs: number;
  retries: number;
  markdownMode: MarkdownMode;
  preprocessMode: PreprocessMode;
  youtubeMode: YoutubeMode;
  firecrawlMode: FirecrawlMode;
  videoMode: VideoMode;
  embeddedVideoMode: EmbeddedVideoMode;
  transcriptTimestamps: boolean;
  transcriptDiarization: DiarizationMode | null;
  outputLanguage: OutputLanguage;
  lengthArg: LengthArg;
  forceSummary: boolean;
  promptOverride: string | null;
  lengthInstruction: string | null;
  languageInstruction: string | null;
  maxOutputTokensArg: number | null;
  allowAutoCliFallback: boolean;
  model: Omit<RunModelSpec, "configForModelSelection">;
  configPath: string | null;
  configModelLabel: string | null;
};

export type ResolvedSummarizeRun = {
  spec: ResolvedSummarizeSpec;
  bindings: {
    context: RunContextState;
    model: RunModelSpec;
    envForRun: Record<string, string | undefined>;
  };
};

function toPublicModelSpec(model: RunModelSpec): Omit<RunModelSpec, "configForModelSelection"> {
  const { configForModelSelection, ...publicModel } = model;
  void configForModelSelection;
  return publicModel;
}

function createDefaultConfigInput(
  request: SummarizeRunRequest,
  overrides: RunOverrides,
): RunConfigInput {
  const languageRaw = typeof request.languageRaw === "string" ? request.languageRaw : null;
  return createRunConfigInput({
    languageRaw,
    languageExplicit: Boolean(languageRaw?.trim()),
    videoModeRaw: overrides.videoMode ?? "auto",
    videoModeExplicit: overrides.videoMode != null,
    embeddedVideoModeRaw: overrides.embeddedVideoMode ?? "auto",
    embeddedVideoModeExplicit: overrides.embeddedVideoMode != null,
  });
}

export function resolveSummarizeRun({
  request,
  env,
  configInput,
  useConfigPromptDefault = false,
}: {
  request: SummarizeRunRequest;
  env: Record<string, string | undefined>;
  configInput?: RunConfigInput | null;
  useConfigPromptDefault?: boolean;
}): ResolvedSummarizeRun {
  const envForRun = { ...env };
  const overrides = request.overrides ?? createEmptyRunOverrides();
  if (overrides.transcriber) {
    envForRun.SUMMARIZE_TRANSCRIBER = overrides.transcriber;
  }

  const context = resolveRunContextState({
    env: envForRun,
    envForRun,
    configInput: configInput ?? createDefaultConfigInput(request, overrides),
  });
  const format = request.format === "markdown" ? "markdown" : "text";
  const { lengthArg } = resolveSummaryLength(
    request.lengthRaw,
    context.config?.output?.length ?? "long",
  );
  const maxOutputTokensArg = overrides.maxOutputTokensArg;
  const configForSelection = applyAutoCliFallbackOverrides(context.configForCli, overrides);
  const model = resolveRunModelSpec({
    context,
    envForRun,
    explicitModelArg: request.modelOverride?.trim() ? request.modelOverride.trim() : null,
    configForSelection,
    lengthArg,
    maxOutputTokensArg,
  });
  const outputLanguage = resolveOutputLanguageSetting({
    raw: request.languageRaw,
    fallback: context.outputLanguage,
  });
  const promptOverride =
    request.promptOverride ??
    (useConfigPromptDefault && typeof context.config?.prompt === "string"
      ? context.config.prompt.trim() || null
      : null);

  return {
    spec: {
      format,
      maxExtractCharacters:
        request.input.kind === "url" || request.input.kind === "input-url"
          ? request.input.maxCharacters
          : null,
      timeoutMs: overrides.timeoutMs ?? 120_000,
      retries: overrides.retries ?? 1,
      markdownMode: overrides.markdownMode ?? (format === "markdown" ? "readability" : "off"),
      preprocessMode: overrides.preprocessMode ?? "auto",
      youtubeMode: overrides.youtubeMode ?? "auto",
      firecrawlMode: overrides.firecrawlMode ?? "off",
      videoMode: context.videoMode,
      embeddedVideoMode: context.embeddedVideoMode,
      transcriptTimestamps: overrides.transcriptTimestamps ?? false,
      transcriptDiarization: overrides.transcriptDiarization ?? null,
      outputLanguage,
      lengthArg,
      forceSummary: overrides.forceSummary ?? false,
      promptOverride,
      lengthInstruction: promptOverride ? buildPromptLengthInstruction(lengthArg) : null,
      languageInstruction:
        promptOverride && outputLanguage.kind === "fixed"
          ? `Output should be ${outputLanguage.label}.`
          : null,
      maxOutputTokensArg,
      allowAutoCliFallback: overrides.autoCliFallbackEnabled === true,
      model: toPublicModelSpec(model),
      configPath: context.configPath,
      configModelLabel: context.configModelLabel,
    },
    bindings: {
      context,
      model,
      envForRun,
    },
  };
}
