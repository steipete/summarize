import type { Context, Message } from "@earendil-works/pi-ai";
import type { CliProvider, SummarizeConfig } from "../config.js";
import { runCliModel } from "../llm/cli.js";
import type { LlmApiKeys } from "../llm/generate-text.js";
import { streamTextWithContext } from "../llm/generate-text.js";
import { resolveGitHubModelsApiKey } from "../llm/github-models.js";
import { mergeModelRequestOptions } from "../llm/model-options.js";
import { buildAutoModelAttempts, envHasKey } from "../model-auto.js";
import { parseBooleanEnv, parseCliUserModelId } from "../run/env.js";
import { resolveEnvState } from "../run/run-env.js";
import { resolveModelSelection } from "../run/run-models.js";

type ChatSession = {
  id: string;
  lastMeta: {
    model: string | null;
    modelLabel: string | null;
    inputSummary: string | null;
    summaryFromCache: boolean | null;
  };
};

type ChatEvent = { event: string; data?: unknown };

const SYSTEM_PROMPT = `You are Summarize Chat.

You answer questions about the current page content. Keep responses concise and grounded in the page.`;

function resolveConfiguredCliModel(
  provider: CliProvider,
  configForCli: SummarizeConfig | null | undefined,
): string | null {
  const cli = configForCli?.cli;
  const raw =
    provider === "claude"
      ? cli?.claude?.model
      : provider === "codex"
        ? cli?.codex?.model
        : provider === "gemini"
          ? cli?.gemini?.model
          : provider === "agent"
            ? cli?.agent?.model
            : provider === "openclaw"
              ? cli?.openclaw?.model
              : cli?.opencode?.model;
  return typeof raw === "string" && raw.trim().length > 0 ? raw.trim() : null;
}

function normalizeMessages(messages: Message[]): Message[] {
  return messages.map((message) => ({
    ...message,
    timestamp: message.timestamp ?? Date.now(),
  }));
}

function buildContext({
  pageUrl,
  pageTitle,
  pageContent,
  messages,
}: {
  pageUrl: string;
  pageTitle: string | null;
  pageContent: string;
  messages: Message[];
}): Context {
  const header = pageTitle ? `${pageTitle} (${pageUrl})` : pageUrl;
  const systemPrompt = `${SYSTEM_PROMPT}\n\nPage:\n${header}\n\nContent:\n${pageContent}`;
  return { systemPrompt, messages: normalizeMessages(messages) };
}

function flattenChatForCli({
  systemPrompt,
  messages,
}: {
  systemPrompt: string;
  messages: Message[];
}): string {
  const parts: string[] = [systemPrompt];
  for (const msg of messages) {
    const role = msg.role === "user" ? "User" : "Assistant";
    const content = typeof msg.content === "string" ? msg.content : "";
    if (content) {
      parts.push(`${role}: ${content}`);
    }
  }
  return parts.join("\n\n");
}

function resolveApiKeys(
  env: Record<string, string | undefined>,
  configForCli: SummarizeConfig | null,
): LlmApiKeys {
  const envState = resolveEnvState({ env, envForRun: env, configForCli });
  return {
    xaiApiKey: envState.xaiApiKey,
    openaiApiKey: envState.apiKey ?? envState.openaiApiKey,
    googleApiKey: envState.googleApiKey,
    anthropicApiKey: envState.anthropicApiKey,
    openrouterApiKey: envState.openrouterApiKey,
  };
}

function resolveOpenAiUseChatCompletions({
  env,
  configForCli,
}: {
  env: Record<string, string | undefined>;
  configForCli: SummarizeConfig | null;
}): boolean {
  const envValue = parseBooleanEnv(env.OPENAI_USE_CHAT_COMPLETIONS);
  if (envValue !== null) return envValue;
  return configForCli?.openai?.useChatCompletions === true;
}

export async function streamChatResponse({
  env,
  fetchImpl,
  configForCli = null,
  session: _session,
  pageUrl,
  pageTitle,
  pageContent,
  messages,
  modelOverride,
  pushToSession,
  emitMeta,
}: {
  env: Record<string, string | undefined>;
  fetchImpl: typeof fetch;
  configForCli?: SummarizeConfig | null;
  session: ChatSession;
  pageUrl: string;
  pageTitle: string | null;
  pageContent: string;
  messages: Message[];
  modelOverride: string | null;
  pushToSession: (event: ChatEvent) => void;
  emitMeta: (patch: Partial<ChatSession["lastMeta"]>) => void;
}) {
  const apiKeys = resolveApiKeys(env, configForCli);
  const envState = resolveEnvState({ env, envForRun: env, configForCli });
  const openaiUseChatCompletions = resolveOpenAiUseChatCompletions({ env, configForCli });
  const openaiRequestOptions = mergeModelRequestOptions(configForCli?.openai);
  const context = buildContext({ pageUrl, pageTitle, pageContent, messages });

  const resolveModel = () => {
    if (modelOverride && modelOverride.trim().length > 0) {
      const { requestedModel: requested } = resolveModelSelection({
        config: configForCli ?? null,
        configForCli: configForCli ?? null,
        configPath: null,
        envForRun: env,
        explicitModelArg: modelOverride,
      });
      if (requested.kind === "auto") {
        return null;
      }
      if (requested.transport === "cli") {
        const cliModel =
          requested.cliModel ?? resolveConfiguredCliModel(requested.cliProvider, configForCli);
        return {
          userModelId: cliModel
            ? `cli/${requested.cliProvider}/${cliModel}`
            : requested.userModelId,
          modelId: null,
          forceOpenRouter: false,
          transport: "cli" as const,
          cliProvider: requested.cliProvider,
          cliModel,
        };
      }
      if (requested.transport === "openrouter") {
        return {
          userModelId: requested.userModelId,
          modelId: requested.llmModelId,
          forceOpenRouter: requested.forceOpenRouter,
          transport: "native" as const,
          openaiApiKeyOverride: null,
          openaiBaseUrlOverride: null,
          forceChatCompletions: false,
        };
      }
      return {
        userModelId: requested.userModelId,
        modelId: requested.llmModelId,
        forceOpenRouter: requested.forceOpenRouter,
        transport: "native" as const,
        openaiApiKeyOverride:
          requested.requiredEnv === "Z_AI_API_KEY"
            ? envState.zaiApiKey
            : requested.requiredEnv === "NVIDIA_API_KEY"
              ? envState.nvidiaApiKey
              : requested.requiredEnv === "GITHUB_TOKEN"
                ? resolveGitHubModelsApiKey(env)
                : null,
        openaiBaseUrlOverride:
          requested.requiredEnv === "Z_AI_API_KEY"
            ? envState.zaiBaseUrl
            : requested.requiredEnv === "NVIDIA_API_KEY"
              ? envState.nvidiaBaseUrl
              : requested.requiredEnv === "OLLAMA_BASE_URL"
                ? envState.ollamaBaseUrl
                : (requested.openaiBaseUrlOverride ?? null),
        forceChatCompletions:
          Boolean(requested.forceChatCompletions) ||
          requested.requiredEnv === "OLLAMA_BASE_URL" ||
          (requested.provider === "openai" && openaiUseChatCompletions),
        requestOptions: requested.requestOptions,
      };
    }
    return null;
  };

  const resolved = resolveModel();
  if (resolved) {
    emitMeta({ model: resolved.userModelId });
    if (resolved.transport === "cli") {
      const prompt = flattenChatForCli({
        systemPrompt: context.systemPrompt ?? "",
        messages: context.messages,
      });
      const result = await runCliModel({
        provider: resolved.cliProvider!,
        prompt,
        model: resolved.cliModel ?? null,
        allowTools: false,
        timeoutMs: 120_000,
        env,
        config: configForCli?.cli ?? null,
      });
      pushToSession({ event: "content", data: result.text });
      pushToSession({ event: "metrics" });
      return;
    }
    const result = await streamTextWithContext({
      modelId: resolved.modelId!,
      apiKeys: {
        ...apiKeys,
        openaiApiKey: resolved.openaiApiKeyOverride ?? apiKeys.openaiApiKey,
      },
      context,
      timeoutMs: 30_000,
      fetchImpl,
      forceOpenRouter: resolved.forceOpenRouter,
      openaiBaseUrlOverride: resolved.openaiBaseUrlOverride,
      forceChatCompletions: resolved.forceChatCompletions,
      requestOptions: mergeModelRequestOptions(openaiRequestOptions, resolved.requestOptions),
    });
    for await (const chunk of result.textStream) {
      pushToSession({ event: "content", data: chunk });
    }
    pushToSession({ event: "metrics" });
    return;
  }

  const attempts = buildAutoModelAttempts({
    kind: "text",
    promptTokens: null,
    desiredOutputTokens: null,
    requiresVideoUnderstanding: false,
    env: envState.envForAuto,
    config: null,
    catalog: null,
    openrouterProvidersFromEnv: null,
    cliAvailability: envState.cliAvailability,
  });

  const apiAttempt = attempts.find(
    (entry) =>
      entry.transport !== "cli" &&
      entry.llmModelId &&
      envHasKey(envState.envForAuto, entry.requiredEnv),
  );
  const cliAttempt = !apiAttempt ? attempts.find((entry) => entry.transport === "cli") : null;
  const attempt = apiAttempt ?? cliAttempt;
  if (!attempt) {
    throw new Error("No model available for chat");
  }

  emitMeta({ model: attempt.userModelId });

  if (attempt.transport === "cli") {
    const parsed = parseCliUserModelId(attempt.userModelId);
    const prompt = flattenChatForCli({
      systemPrompt: context.systemPrompt ?? "",
      messages: context.messages,
    });
    const result = await runCliModel({
      provider: parsed.provider,
      prompt,
      model: parsed.model,
      allowTools: false,
      timeoutMs: 120_000,
      env,
      config: configForCli?.cli ?? null,
    });
    pushToSession({ event: "content", data: result.text });
    pushToSession({ event: "metrics" });
    void _session;
    return;
  }

  const result = await streamTextWithContext({
    modelId: attempt.llmModelId!,
    apiKeys,
    context,
    timeoutMs: 30_000,
    fetchImpl,
    forceOpenRouter: attempt.forceOpenRouter,
    forceChatCompletions: attempt.requiredEnv === "OPENAI_API_KEY" && openaiUseChatCompletions,
    requestOptions: mergeModelRequestOptions(openaiRequestOptions, attempt.requestOptions),
  });
  for await (const chunk of result.textStream) {
    pushToSession({ event: "content", data: chunk });
  }
  pushToSession({ event: "metrics" });
  void _session;
}
