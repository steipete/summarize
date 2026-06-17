import type { SummarizeConfig } from "../config.js";
import { resolveGitHubModelsApiKey } from "../llm/github-models.js";
import type { ProviderRuntimeBindings } from "../llm/provider-profile.js";
import type { EnvState } from "./environment-state.js";
import { parseBooleanEnv } from "./environment.js";

export function resolveOpenAiUseChatCompletions({
  env,
  configForCli,
}: {
  env: Record<string, string | undefined>;
  configForCli: SummarizeConfig | null;
}): boolean | undefined {
  const envValue = parseBooleanEnv(env.OPENAI_USE_CHAT_COMPLETIONS);
  if (envValue !== null) return envValue;
  return typeof configForCli?.openai?.useChatCompletions === "boolean"
    ? configForCli.openai.useChatCompletions
    : undefined;
}

export function resolveProviderRuntimeBindings({
  env,
  envState,
  configForCli,
}: {
  env: Record<string, string | undefined>;
  envState: EnvState;
  configForCli: SummarizeConfig | null;
}): ProviderRuntimeBindings {
  return {
    apiKeys: {
      xai: envState.xaiApiKey,
      openai: envState.apiKey,
      evolink: envState.evolinkApiKey,
      google: envState.googleApiKey,
      anthropic: envState.anthropicApiKey,
      zai: envState.zaiApiKey,
      nvidia: envState.nvidiaApiKey,
      minimax: envState.minimaxApiKey,
      "github-copilot": resolveGitHubModelsApiKey(env),
      ollama: null,
    },
    baseUrls: {
      xai: envState.providerBaseUrls.xai,
      openai: envState.providerBaseUrls.openai,
      evolink: envState.evolinkBaseUrl,
      google: envState.providerBaseUrls.google,
      anthropic: envState.providerBaseUrls.anthropic,
      zai: envState.zaiBaseUrl,
      nvidia: envState.nvidiaBaseUrl,
      minimax: envState.minimaxBaseUrl,
      ollama: envState.ollamaBaseUrl,
    },
    openaiUseChatCompletions: resolveOpenAiUseChatCompletions({ env, configForCli }),
  };
}
