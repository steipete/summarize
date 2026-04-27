import type { CliProvider } from "../config.js";
import type { LlmProvider } from "../llm/model-id.js";
import type { ModelRequestOptions } from "../llm/model-options.js";

export type ModelAttemptRequiredEnv =
  | "XAI_API_KEY"
  | "OPENAI_API_KEY"
  | "NVIDIA_API_KEY"
  | "GEMINI_API_KEY"
  | "ANTHROPIC_API_KEY"
  | "OPENROUTER_API_KEY"
  | "Z_AI_API_KEY"
  | "GITHUB_TOKEN"
  | "CLI_CLAUDE"
  | "CLI_CODEX"
  | "CLI_GEMINI"
  | "CLI_AGENT"
  | "CLI_OPENCLAW"
  | "CLI_OPENCODE"
  | "CLI_COPILOT";

export type ModelAttempt = {
  transport: "native" | "openrouter" | "cli";
  userModelId: string;
  llmModelId: string | null;
  openrouterProviders: string[] | null;
  forceOpenRouter: boolean;
  requiredEnv: ModelAttemptRequiredEnv;
  openaiBaseUrlOverride?: string | null;
  openaiApiKeyOverride?: string | null;
  forceChatCompletions?: boolean;
  requestOptions?: ModelRequestOptions;
  cliProvider?: CliProvider;
  cliModel?: string | null;
};

export type ModelMeta = {
  provider: LlmProvider | "cli";
  canonical: string;
};

export type MarkdownModel = {
  llmModelId: string;
  forceOpenRouter: boolean;
  openaiApiKeyOverride?: string | null;
  openaiBaseUrlOverride?: string | null;
  forceChatCompletions?: boolean;
  requestOptions?: ModelRequestOptions;
  requiredEnv?: ModelAttemptRequiredEnv;
};
