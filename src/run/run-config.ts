import type { CliProvider, SummarizeConfig } from "../config.js";
import { loadSummarizeConfig } from "../config.js";
import { parseVideoMode } from "../flags.js";
import { type OutputLanguage, parseOutputLanguage } from "../language.js";
import { parseOpenAiReasoningEffort, parseOpenAiServiceTier } from "../llm/model-options.js";
import type { ModelRequestOptions } from "../llm/model-options.js";
import { parseBooleanEnv } from "./env.js";

export type ConfigState = {
  config: SummarizeConfig | null;
  configPath: string | null;
  outputLanguage: OutputLanguage;
  openaiWhisperUsdPerMinute: number;
  videoMode: ReturnType<typeof parseVideoMode>;
  cliConfigForRun: SummarizeConfig["cli"] | undefined;
  configForCli: SummarizeConfig | null;
  openaiUseChatCompletions: boolean;
  openaiRequestOptions: ModelRequestOptions | undefined;
  openaiRequestOptionsOverride: ModelRequestOptions | undefined;
  configModelLabel: string | null;
};

export function resolveConfigState({
  envForRun,
  programOpts,
  languageExplicitlySet,
  videoModeExplicitlySet,
  cliFlagPresent,
  cliProviderArg,
}: {
  envForRun: Record<string, string | undefined>;
  programOpts: Record<string, unknown>;
  languageExplicitlySet: boolean;
  videoModeExplicitlySet: boolean;
  cliFlagPresent: boolean;
  cliProviderArg: CliProvider | null;
}): ConfigState {
  const { config, path: configPath } = loadSummarizeConfig({ env: envForRun });
  const cliLanguageRaw =
    typeof programOpts.language === "string"
      ? (programOpts.language as string)
      : typeof programOpts.lang === "string"
        ? (programOpts.lang as string)
        : null;
  const defaultLanguageRaw = (config?.output?.language ?? config?.language ?? "auto") as string;
  const outputLanguage: OutputLanguage = parseOutputLanguage(
    languageExplicitlySet && typeof cliLanguageRaw === "string" && cliLanguageRaw.trim().length > 0
      ? cliLanguageRaw
      : defaultLanguageRaw,
  );
  const openaiWhisperUsdPerMinute = (() => {
    const value = config?.openai?.whisperUsdPerMinute;
    return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0.006;
  })();
  const videoMode = parseVideoMode(
    videoModeExplicitlySet
      ? (programOpts.videoMode as string)
      : (config?.media?.videoMode ?? (programOpts.videoMode as string)),
  );

  const cliEnabledOverride: CliProvider[] | null = (() => {
    if (!cliFlagPresent || cliProviderArg) return null;
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
    return typeof configValue === "boolean" ? configValue : false;
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
    const rawServiceTier =
      typeof programOpts.serviceTier === "string" ? programOpts.serviceTier : null;
    if (programOpts.fast === true) {
      options.serviceTier = "fast";
    }
    if (rawServiceTier) {
      const serviceTier = parseOpenAiServiceTier(rawServiceTier, "--service-tier");
      if (options.serviceTier && options.serviceTier !== serviceTier) {
        throw new Error("Use either --fast or --service-tier (not both with different values).");
      }
      options.serviceTier = serviceTier;
    }
    const rawThinking = typeof programOpts.thinking === "string" ? programOpts.thinking : null;
    if (rawThinking) {
      options.reasoningEffort = parseOpenAiReasoningEffort(rawThinking, "--thinking");
    }
    return Object.keys(options).length > 0 ? options : undefined;
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
    cliConfigForRun,
    configForCli,
    openaiUseChatCompletions,
    openaiRequestOptions,
    openaiRequestOptionsOverride,
    configModelLabel,
  };
}
