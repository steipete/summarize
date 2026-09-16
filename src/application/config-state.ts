import type { CliProvider, SummarizeConfig } from "../config.js";
import { loadSummarizeConfig } from "../config.js";
import { parseEmbeddedVideoMode, parseVideoMode } from "../flags.js";
import { type OutputLanguage, parseOutputLanguage } from "../language.js";
import { parseOpenAiReasoningEffort, parseOpenAiServiceTier } from "../llm/model-options.js";
import type { ModelRequestOptions, OpenAiReasoningEffort } from "../llm/model-options.js";
import { CliError } from "../locale.js";
import { parseBooleanEnv } from "./environment.js";

export type ConfigState = {
  config: SummarizeConfig | null;
  configPath: string | null;
  outputLanguage: OutputLanguage;
  openaiWhisperUsdPerMinute: number;
  videoMode: ReturnType<typeof parseVideoMode>;
  embeddedVideoMode: ReturnType<typeof parseEmbeddedVideoMode>;
  cliConfigForRun: SummarizeConfig["cli"] | undefined;
  configForCli: SummarizeConfig | null;
  openaiUseChatCompletions: boolean | undefined;
  openaiRequestOptions: ModelRequestOptions | undefined;
  openaiRequestOptionsOverride: ModelRequestOptions | undefined;
  cliReasoningEffortOverride: OpenAiReasoningEffort | undefined;
  configModelLabel: string | null;
};

export type RunConfigInput = {
  languageRaw: string | null;
  languageExplicit: boolean;
  videoModeRaw: string;
  videoModeExplicit: boolean;
  embeddedVideoModeRaw: string;
  embeddedVideoModeExplicit: boolean;
  cliFlagPresent: boolean;
  cliProvider: CliProvider | null;
  fast: boolean;
  serviceTierRaw: string | null;
  thinkingRaw: string | null;
};

export function createRunConfigInput(overrides: Partial<RunConfigInput> = {}): RunConfigInput {
  return {
    languageRaw: null,
    languageExplicit: false,
    videoModeRaw: "auto",
    videoModeExplicit: false,
    embeddedVideoModeRaw: "auto",
    embeddedVideoModeExplicit: false,
    cliFlagPresent: false,
    cliProvider: null,
    fast: false,
    serviceTierRaw: null,
    thinkingRaw: null,
    ...overrides,
  };
}

export function resolveConfigState({
  envForRun,
  input,
}: {
  envForRun: Record<string, string | undefined>;
  input: RunConfigInput;
}): ConfigState {
  const { config, path: configPath } = loadSummarizeConfig({ env: envForRun });
  const defaultLanguageRaw = (config?.output?.language ?? config?.language ?? "auto") as string;
  const outputLanguage: OutputLanguage = parseOutputLanguage(
    input.languageExplicit && input.languageRaw?.trim() ? input.languageRaw : defaultLanguageRaw,
  );
  const openaiWhisperUsdPerMinute = (() => {
    const value = config?.openai?.whisperUsdPerMinute;
    return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0.006;
  })();
  const videoMode = parseVideoMode(
    input.videoModeExplicit ? input.videoModeRaw : (config?.media?.videoMode ?? input.videoModeRaw),
  );
  const embeddedVideoMode = parseEmbeddedVideoMode(
    input.embeddedVideoModeExplicit
      ? input.embeddedVideoModeRaw
      : (config?.media?.embeddedVideo ?? input.embeddedVideoModeRaw),
  );

  const cliEnabledOverride: CliProvider[] | null = (() => {
    if (!input.cliFlagPresent || input.cliProvider) return null;
    if (Array.isArray(config?.cli?.enabled)) return config.cli.enabled;
    return ["claude", "gemini", "codex", "agent", "openclaw", "opencode", "copilot"];
  })();
  const cliConfigForRun = cliEnabledOverride
    ? { ...(config?.cli ?? {}), enabled: cliEnabledOverride }
    : config?.cli;
  const configForCli: SummarizeConfig | null =
    cliEnabledOverride !== null
      ? { ...(config ?? {}), ...(cliConfigForRun ? { cli: cliConfigForRun } : {}) }
      : config;

  const openaiUseChatCompletions = (() => {
    const envValue = parseBooleanEnv(
      typeof envForRun.OPENAI_USE_CHAT_COMPLETIONS === "string"
        ? envForRun.OPENAI_USE_CHAT_COMPLETIONS
        : null,
    );
    if (envValue !== null) return envValue;
    const configValue = config?.openai?.useChatCompletions;
    return typeof configValue === "boolean" ? configValue : undefined;
  })();

  const openaiRequestOptions: ModelRequestOptions | undefined = (() => {
    const options: ModelRequestOptions = {};
    if (typeof config?.openai?.serviceTier === "string") {
      options.serviceTier = config.openai.serviceTier;
    }
    if (config?.openai?.reasoningEffort ?? config?.openai?.thinking) {
      options.reasoningEffort = config.openai.reasoningEffort ?? config.openai.thinking;
    }
    if (config?.openai?.textVerbosity) {
      options.textVerbosity = config.openai.textVerbosity;
    }
    return Object.keys(options).length > 0 ? options : undefined;
  })();

  const openaiRequestOptionsOverride: ModelRequestOptions | undefined = (() => {
    const options: ModelRequestOptions = {};
    if (input.fast) {
      options.serviceTier = "fast";
    }
    if (input.serviceTierRaw) {
      const serviceTier = parseOpenAiServiceTier(input.serviceTierRaw, "--service-tier");
      if (options.serviceTier && options.serviceTier !== serviceTier) {
        throw new CliError("error.fastServiceTierConflict");
      }
      options.serviceTier = serviceTier;
    }
    return Object.keys(options).length > 0 ? options : undefined;
  })();

  const cliReasoningEffortOverride: OpenAiReasoningEffort | undefined = (() => {
    if (!input.thinkingRaw) return undefined;
    return parseOpenAiReasoningEffort(input.thinkingRaw, "--thinking");
  })();

  const configModelLabel = (() => {
    const model = config?.model;
    if (!model) return null;
    if ("id" in model) return model.id;
    if ("name" in model) return model.name;
    if ("mode" in model && model.mode === "auto") return "auto";
    return null;
  })();

  return {
    config,
    configPath,
    outputLanguage,
    openaiWhisperUsdPerMinute,
    videoMode,
    embeddedVideoMode,
    cliConfigForRun,
    configForCli,
    openaiUseChatCompletions,
    openaiRequestOptions,
    openaiRequestOptionsOverride,
    cliReasoningEffortOverride,
    configModelLabel,
  };
}
