export type AutoRuleKind = "text" | "website" | "youtube" | "image" | "video" | "file";
export type VideoMode = "auto" | "transcript" | "understand";
export type CliProvider = "claude" | "codex" | "gemini" | "agent" | "openclaw" | "opencode";
export type CliProviderConfig = {
  binary?: string;
  extraArgs?: string[];
  model?: string;
};
export type CliAutoFallbackConfig = {
  enabled?: boolean;
  onlyWhenNoApiKeys?: boolean;
  order?: CliProvider[];
};
export type CliMagicAutoConfig = CliAutoFallbackConfig;
export type CliConfig = {
  enabled?: CliProvider[];
  claude?: CliProviderConfig;
  codex?: CliProviderConfig;
  gemini?: CliProviderConfig;
  agent?: CliProviderConfig;
  openclaw?: CliProviderConfig;
  opencode?: CliProviderConfig;
  autoFallback?: CliAutoFallbackConfig;
  magicAuto?: CliAutoFallbackConfig;
  promptOverride?: string;
  allowTools?: boolean;
  cwd?: string;
  extraArgs?: string[];
};

export type OpenAiConfig = {
  /**
   * Override the OpenAI-compatible API base URL (e.g. a proxy, OpenRouter, or a local gateway).
   *
   * Prefer env `OPENAI_BASE_URL` when you need per-run overrides.
   */
  baseUrl?: string;
  useChatCompletions?: boolean;
  /**
   * USD per minute for OpenAI Whisper transcription cost estimation.
   *
   * Default: 0.006 (per OpenAI pricing as of 2025-12-24).
   */
  whisperUsdPerMinute?: number;
};

export type MediaCacheVerifyMode = "none" | "size" | "hash";
export type MediaCacheConfig = {
  enabled?: boolean;
  maxMb?: number;
  ttlDays?: number;
  path?: string;
  verify?: MediaCacheVerifyMode;
};

export type AnthropicConfig = {
  /**
   * Override the Anthropic API base URL (e.g. a proxy).
   *
   * Prefer env `ANTHROPIC_BASE_URL` when you need per-run overrides.
   */
  baseUrl?: string;
};

export type GoogleConfig = {
  /**
   * Override the Google Generative Language API base URL (e.g. a proxy).
   *
   * Prefer env `GOOGLE_BASE_URL` / `GEMINI_BASE_URL` when you need per-run overrides.
   */
  baseUrl?: string;
};

export type NvidiaConfig = {
  /**
   * Override the NVIDIA OpenAI-compatible API base URL.
   *
   * Default: https://integrate.api.nvidia.com/v1
   *
   * Prefer env `NVIDIA_BASE_URL` when you need per-run overrides.
   */
  baseUrl?: string;
};

export type ApiKeysConfig = {
  openai?: string;
  nvidia?: string;
  anthropic?: string;
  google?: string;
  xai?: string;
  openrouter?: string;
  zai?: string;
  apify?: string;
  firecrawl?: string;
  fal?: string;
  groq?: string;
  assemblyai?: string;
};

export type EnvConfig = Record<string, string>;

export type LoggingLevel = "debug" | "info" | "warn" | "error";
export type LoggingFormat = "json" | "pretty";
export type LoggingConfig = {
  enabled?: boolean;
  level?: LoggingLevel;
  format?: LoggingFormat;
  file?: string;
  maxMb?: number;
  maxFiles?: number;
};

export type XaiConfig = {
  /**
   * Override the xAI API base URL (e.g. a proxy).
   *
   * Prefer env `XAI_BASE_URL` when you need per-run overrides.
   */
  baseUrl?: string;
};

export type ZaiConfig = {
  /**
   * Override the Z.AI API base URL (e.g. use China endpoint).
   *
   * Default: https://api.z.ai/api/paas/v4
   * China: https://api.zhipuai.cn/paas/v4
   *
   * Prefer env `Z_AI_BASE_URL` when you need per-run overrides.
   */
  baseUrl?: string;
};

export type AutoRule = {
  /**
   * Input kinds this rule applies to.
   *
   * Omit for "catch-all".
   */
  when?: AutoRuleKind[];

  /**
   * Candidate model ids (ordered).
   *
   * - Native: `openai/...`, `google/...`, `xai/...`, `anthropic/...`, `zai/...`
   * - OpenRouter (forced): `openrouter/<provider>/<model>` (e.g. `openrouter/openai/gpt-5-mini`)
   */
  candidates?: string[];

  /**
   * Token-based candidate selection (ordered).
   *
   * First matching band wins.
   */
  bands?: Array<{
    token?: { min?: number; max?: number };
    candidates: string[];
  }>;
};

export type ModelConfig =
  | {
      id: string;
    }
  | {
      mode: "auto";
      rules?: AutoRule[];
    }
  | { name: string };

export type SummarizeConfig = {
  model?: ModelConfig;
  /**
   * Output language for summaries (default: auto = match source content language).
   *
   * Examples: "en", "de", "english", "german", "pt-BR".
   */
  language?: string;
  /**
   * Summary prompt override (replaces the built-in instruction block).
   */
  prompt?: string;
  /**
   * Cache settings for extracted content, transcripts, and summaries.
   */
  cache?: {
    enabled?: boolean;
    maxMb?: number;
    ttlDays?: number;
    path?: string;
    media?: MediaCacheConfig;
  };
  /**
   * Named model presets selectable via `--model <name>`.
   *
   * Note: `auto` is reserved and cannot be defined here.
   */
  models?: Record<string, ModelConfig>;
  media?: {
    videoMode?: VideoMode;
  };
  slides?: {
    enabled?: boolean;
    ocr?: boolean;
    dir?: string;
    sceneThreshold?: number;
    max?: number;
    minDuration?: number;
  };
  output?: {
    /**
     * Output language for the summary (e.g. "auto", "en", "de", "English").
     *
     * - "auto": match the source language (default behavior when unset)
     * - otherwise: translate the output into the requested language
     */
    language?: string;
    /**
     * Default summary length (same values as `--length`).
     *
     * Examples: "short", "long", "xl", "20k".
     */
    length?: string;
  };
  ui?: {
    /**
     * CLI theme name (e.g. "aurora", "ember", "moss", "mono").
     */
    theme?: string;
  };
  cli?: CliConfig;
  openai?: OpenAiConfig;
  nvidia?: NvidiaConfig;
  anthropic?: AnthropicConfig;
  google?: GoogleConfig;
  xai?: XaiConfig;
  zai?: ZaiConfig;
  logging?: LoggingConfig;
  /**
   * Generic environment variable defaults.
   *
   * Precedence: process env > config file env.
   */
  env?: EnvConfig;
  /**
   * Legacy API key shortcuts. Prefer `env` for new configs.
   *
   * Precedence: environment variables > config file apiKeys.
   */
  apiKeys?: ApiKeysConfig;
};
