import type { Context, Message } from "@earendil-works/pi-ai";
import { resolveEnvState } from "../application/environment-state.js";
import {
  resolveModelAttempts,
  selectPreferredInteractiveModelAttempt,
} from "../application/model-attempts.js";
import { resolveModelSelection } from "../application/model-selection.js";
import { resolveProviderRuntimeBindings } from "../application/provider-runtime.js";
import type { SummarizeConfig } from "../config.js";
import { runCliModel } from "../llm/cli.js";
import type { LlmApiKeys } from "../llm/generate-text.js";
import { streamTextWithContext } from "../llm/generate-text.js";
import { parseGatewayStyleModelId } from "../llm/model-id.js";
import { mergeModelRequestOptions, mergeRequestOptionsForProvider } from "../llm/model-options.js";

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
  const providerRuntime = resolveProviderRuntimeBindings({ env, envState, configForCli });
  const openaiRequestOptions = mergeModelRequestOptions(configForCli?.openai);
  const context = buildContext({ pageUrl, pageTitle, pageContent, messages });

  const requestedModel =
    modelOverride && modelOverride.trim().length > 0
      ? resolveModelSelection({
          config: configForCli ?? null,
          configForCli: configForCli ?? null,
          configPath: null,
          envForRun: env,
          explicitModelArg: modelOverride,
        }).requestedModel
      : ({ kind: "auto" } as const);
  const attempts = resolveModelAttempts({
    requestedModel,
    kind: "text",
    promptTokens: null,
    desiredOutputTokens: null,
    requiresVideoUnderstanding: false,
    envForAuto: envState.envForAuto,
    configForModelSelection: null,
    catalog: null,
    openrouterProvidersFromEnv: null,
    cliAvailability: envState.cliAvailability,
    providerRuntime,
  });
  const attempt =
    requestedModel.kind === "fixed"
      ? (attempts[0] ?? null)
      : selectPreferredInteractiveModelAttempt({
          attempts,
          envForAuto: envState.envForAuto,
          cliAvailability: envState.cliAvailability,
          requireCliAvailability: false,
        });
  if (!attempt) {
    throw new Error("No model available for chat");
  }

  emitMeta({ model: attempt.userModelId });

  if (attempt.transport === "cli") {
    const prompt = flattenChatForCli({
      systemPrompt: context.systemPrompt ?? "",
      messages: context.messages,
    });
    const result = await runCliModel({
      provider: attempt.cliProvider!,
      prompt,
      model: attempt.cliModel ?? null,
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
    apiKeys:
      attempt.openaiApiKeyOverride === undefined
        ? apiKeys
        : { ...apiKeys, openaiApiKey: attempt.openaiApiKeyOverride },
    context,
    timeoutMs: 30_000,
    fetchImpl,
    forceOpenRouter: attempt.forceOpenRouter,
    openaiBaseUrlOverride:
      attempt.transport === "openrouter" ? undefined : attempt.openaiBaseUrlOverride,
    forceChatCompletions:
      attempt.transport === "openrouter" ? undefined : attempt.forceChatCompletions,
    requestOptions: mergeRequestOptionsForProvider({
      provider: parseGatewayStyleModelId(attempt.llmModelId!).provider,
      openaiGlobalDefault: openaiRequestOptions,
      attemptOptions: attempt.requestOptions,
      openaiOverride: undefined,
    }),
  });
  for await (const chunk of result.textStream) {
    pushToSession({ event: "content", data: chunk });
  }
  pushToSession({ event: "metrics" });
  void _session;
}
