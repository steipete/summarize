import type { CliProvider } from "../config.js";
import type { LlmCall } from "../costs.js";
import { isCliDisabled, runCliModel } from "../llm/cli.js";
import { isRetryableLlmError, resolveLlmErrorMessage } from "../llm/generate-text-shared.js";
import { generateTextWithModelId, streamTextWithModelId } from "../llm/generate-text.js";
import { parseGatewayStyleModelId } from "../llm/model-id.js";
import { mergeRequestOptionsForProvider } from "../llm/model-options.js";
import type { ModelRequestOptions, OpenAiReasoningEffort } from "../llm/model-options.js";
import type { Prompt } from "../llm/prompt.js";
import {
  cliProviderForRequiredEnv,
  formatMissingCliModelError,
  gatewayProviderForRequiredEnv,
} from "../llm/provider-capabilities.js";
import type { ProviderRuntimeBindings } from "../llm/provider-profile.js";
import { formatCompactCount } from "../shared/format-count.js";
import { countTokens } from "../tokenizer.js";
import { EngineError, hasEngineErrorCode } from "./errors.js";
import type { SummaryStreamHandler } from "./events.js";
import { resolveModelIdForLlmCall } from "./model-call.js";
import {
  canStream,
  isGoogleStreamingUnsupportedError,
  isStreamingTimeoutError,
  mergeStreamingChunk,
} from "./streaming.js";
import type { ModelAttempt, SummaryAttemptResult } from "./types.js";

export type ModelExecutorDeps = {
  env: Record<string, string | undefined>;
  envForRun: Record<string, string | undefined>;
  execFileImpl: Parameters<typeof runCliModel>[0]["execFileImpl"];
  timeoutMs: number;
  retries: number;
  streamingEnabled: boolean;
  openaiRequestOptions?: ModelRequestOptions;
  openaiRequestOptionsOverride?: ModelRequestOptions;
  cliReasoningEffortOverride?: OpenAiReasoningEffort;
  cliConfigForRun: Parameters<typeof runCliModel>[0]["config"];
  cliAvailability: Partial<Record<CliProvider, boolean>>;
  trackedFetch: typeof fetch;
  resolveMaxOutputTokensForCall: (modelId: string) => Promise<number | null>;
  resolveMaxInputTokensForCall: (modelId: string) => Promise<number | null>;
  llmCalls: LlmCall[];
  log?: ((message: string) => void) | null;
  trace?: ((name: string, detail?: string | null) => void) | null;
  providerRuntime: ProviderRuntimeBindings;
  openrouterApiKey: string | null;
};

class StreamHandlerError extends Error {
  readonly handlerError: unknown;

  constructor(handlerError: unknown) {
    const normalized =
      handlerError instanceof Error
        ? handlerError
        : new Error(resolveLlmErrorMessage(handlerError) || "Summary output failed", {
            cause: handlerError,
          });
    super(normalized.message, { cause: normalized });
    this.name = "StreamHandlerError";
    this.handlerError = normalized;
  }
}

function normalizeStreamError(error: unknown): Error {
  return error instanceof Error
    ? error
    : new Error(resolveLlmErrorMessage(error) || "LLM stream failed", { cause: error });
}

function streamInterrupted(error: unknown): EngineError {
  const cause = normalizeStreamError(error);
  return new EngineError("SUMMARY_STREAM_INTERRUPTED", cause.message, { cause });
}

async function consumeSummaryStream(
  result: Awaited<ReturnType<typeof streamTextWithModelId>>,
  handler: SummaryStreamHandler | null | undefined,
  trace: ModelExecutorDeps["trace"],
): Promise<Pick<SummaryAttemptResult, "summary" | "summaryEmitted">> {
  let streamed = "";
  let handlerStarted = false;
  let outputEmitted = false;
  const emitChunk = async (next: string, appended: string) => {
    const previous = streamed;
    streamed = next;
    if (!handler || (!handlerStarted && !streamed.trim())) return;
    const firstChunk = !handlerStarted;
    handlerStarted = true;
    try {
      outputEmitted =
        (await handler.onChunk({
          streamed,
          prevStreamed: firstChunk ? "" : previous,
          appended: firstChunk ? streamed : appended,
        })) || outputEmitted;
    } catch (error) {
      throw new StreamHandlerError(error);
    }
  };
  const throwIfFailed = () => {
    const error = result.lastError();
    if (error) throw normalizeStreamError(error);
  };
  try {
    let sawFirstDelta = false;
    for await (const delta of result.textStream) {
      if (!sawFirstDelta) {
        sawFirstDelta = true;
        trace?.("summary:first-delta");
      }
      const merged = mergeStreamingChunk(streamed, delta);
      await emitChunk(merged.next, merged.appended);
    }
    throwIfFailed();
    const finalText = (await result.finalText)?.trim() ?? "";
    throwIfFailed();
    if (finalText.length > streamed.length && finalText.startsWith(streamed)) {
      await emitChunk(finalText, finalText.slice(streamed.length));
    }
    if (!streamed.trim()) throw new Error("LLM returned an empty summary");
  } catch (error) {
    if (handler && handlerStarted && !outputEmitted) {
      try {
        await handler.onReset();
      } catch (resetError) {
        throw streamInterrupted(new StreamHandlerError(resetError).handlerError);
      }
    }
    if (error instanceof StreamHandlerError) throw streamInterrupted(error.handlerError);
    throw outputEmitted ? streamInterrupted(error) : error;
  }
  let finalOutputEmitted = false;
  if (handler && handlerStarted) {
    try {
      finalOutputEmitted = (await handler.onDone?.(streamed)) ?? false;
    } catch (error) {
      throw streamInterrupted(error);
    }
  }
  return { summary: streamed.trim(), summaryEmitted: outputEmitted || finalOutputEmitted };
}

export function createModelExecutor(deps: ModelExecutorDeps) {
  const providerRuntime = deps.providerRuntime;

  const createRetryLogger = (modelId: string) => {
    return (notice: { attempt: number; maxRetries: number; delayMs: number; error?: unknown }) => {
      const message =
        typeof notice.error === "string"
          ? notice.error
          : notice.error instanceof Error
            ? notice.error.message
            : typeof (notice.error as { message?: unknown } | null)?.message === "string"
              ? String((notice.error as { message?: unknown }).message)
              : "";
      const reason = /empty summary/i.test(message)
        ? "empty output"
        : /timed out/i.test(message)
          ? "timeout"
          : "error";
      deps.log?.(
        `LLM ${reason} for ${modelId}; retry ${notice.attempt}/${notice.maxRetries} in ${notice.delayMs}ms.`,
      );
    };
  };

  const envHasKeyFor = (requiredEnv: ModelAttempt["requiredEnv"]) => {
    const cliProvider = cliProviderForRequiredEnv(requiredEnv);
    if (cliProvider) return Boolean(deps.cliAvailability[cliProvider]);
    if (requiredEnv === "OPENROUTER_API_KEY") {
      return Boolean(deps.openrouterApiKey);
    }
    const gatewayProvider = gatewayProviderForRequiredEnv(requiredEnv);
    if (!gatewayProvider || gatewayProvider === "ollama") return gatewayProvider === "ollama";
    return Boolean(providerRuntime.apiKeys[gatewayProvider]);
  };

  const formatMissingModelError = (attempt: ModelAttempt): string => {
    const cliError = formatMissingCliModelError(attempt);
    if (cliError) return cliError;
    return `Missing ${attempt.requiredEnv} for model ${attempt.userModelId}. Set the env var or choose a different --model.`;
  };

  const runSummaryAttempt = async ({
    attempt,
    prompt,
    allowStreaming,
    onModelChosen,
    cli,
    streamHandler,
  }: {
    attempt: ModelAttempt;
    prompt: Prompt;
    allowStreaming: boolean;
    onModelChosen?: ((modelId: string) => void) | null;
    cli?: {
      promptOverride?: string;
      allowTools?: boolean;
      cwd?: string;
      extraArgsByProvider?: Partial<Record<CliProvider, string[]>>;
    } | null;
    streamHandler?: SummaryStreamHandler | null;
  }): Promise<SummaryAttemptResult> => {
    onModelChosen?.(attempt.userModelId);
    deps.trace?.("summary:model-chosen", attempt.userModelId);

    if (attempt.transport === "cli") {
      const hasAttachments = (prompt.attachments?.length ?? 0) > 0;
      const cliPrompt = hasAttachments ? (cli?.promptOverride ?? null) : prompt.userText;
      if (!cliPrompt) {
        throw new Error("CLI models require a text prompt (no binary attachments).");
      }
      if (!attempt.cliProvider) {
        throw new Error(`Missing CLI provider for model ${attempt.userModelId}.`);
      }
      if (isCliDisabled(attempt.cliProvider, deps.cliConfigForRun)) {
        throw new Error(
          `CLI provider ${attempt.cliProvider} is disabled by cli.enabled. Update your config to enable it.`,
        );
      }
      const result = await runCliModel({
        provider: attempt.cliProvider,
        prompt: cliPrompt,
        model: attempt.cliModel ?? null,
        allowTools: Boolean(cli?.allowTools),
        timeoutMs: deps.timeoutMs,
        env: deps.env,
        execFileImpl: deps.execFileImpl,
        config: deps.cliConfigForRun ?? null,
        cwd: cli?.cwd,
        extraArgs: cli?.extraArgsByProvider?.[attempt.cliProvider],
        systemPrompt: prompt.system ?? null,
      });
      const summary = result.text.trim();
      if (!summary) throw new Error("CLI returned an empty summary");
      if (result.usage || typeof result.costUsd === "number") {
        deps.llmCalls.push({
          provider: "cli",
          model: attempt.userModelId,
          usage: result.usage ?? null,
          costUsd: result.costUsd ?? null,
          purpose: "summary",
        });
      }
      return {
        summary,
        summaryEmitted: false,
        modelMeta: { provider: "cli", canonical: attempt.userModelId },
        maxOutputTokensForCall: null,
      };
    }

    if (!attempt.llmModelId) {
      throw new Error(`Missing model id for ${attempt.userModelId}.`);
    }
    const parsedModel = parseGatewayStyleModelId(attempt.llmModelId);
    const apiKeysForLlm = {
      xaiApiKey: providerRuntime.apiKeys.xai ?? null,
      openaiApiKey:
        attempt.openaiApiKeyOverride === undefined
          ? (providerRuntime.apiKeys.openai ?? null)
          : attempt.openaiApiKeyOverride,
      googleApiKey: providerRuntime.apiKeys.google ?? null,
      anthropicApiKey: providerRuntime.apiKeys.anthropic ?? null,
      openrouterApiKey: deps.openrouterApiKey,
    };

    const modelResolution = await resolveModelIdForLlmCall({
      parsedModel,
      apiKeys: { googleApiKey: apiKeysForLlm.googleApiKey },
      googleBaseUrlOverride: providerRuntime.baseUrls.google,
      fetchImpl: deps.trackedFetch,
      timeoutMs: deps.timeoutMs,
    });
    if (modelResolution.note) deps.log?.(modelResolution.note);
    const parsedModelEffective = parseGatewayStyleModelId(modelResolution.modelId);
    const requestOptions = mergeRequestOptionsForProvider({
      provider: parsedModelEffective.provider,
      openaiGlobalDefault: deps.openaiRequestOptions,
      attemptOptions: attempt.requestOptions,
      openaiOverride: deps.openaiRequestOptionsOverride,
      cliReasoningEffortOverride: deps.cliReasoningEffortOverride,
    });
    const streamingEnabledForCall =
      allowStreaming &&
      deps.streamingEnabled &&
      canStream({
        provider: parsedModelEffective.provider,
        prompt,
        transport: attempt.transport === "openrouter" ? "openrouter" : "native",
      });
    const forceChatCompletions =
      typeof attempt.forceChatCompletions === "boolean"
        ? attempt.forceChatCompletions
        : attempt.transport === "openrouter"
          ? undefined
          : parsedModelEffective.provider === "openai"
            ? providerRuntime.openaiUseChatCompletions
            : undefined;

    const maxOutputTokensForCall = await deps.resolveMaxOutputTokensForCall(
      parsedModelEffective.canonical,
    );
    deps.trace?.("summary:max-output");
    const maxInputTokensForCall = await deps.resolveMaxInputTokensForCall(
      parsedModelEffective.canonical,
    );
    deps.trace?.("summary:max-input");
    if (
      typeof maxInputTokensForCall === "number" &&
      Number.isFinite(maxInputTokensForCall) &&
      maxInputTokensForCall > 0 &&
      (prompt.attachments?.length ?? 0) === 0
    ) {
      const tokenCount = countTokens(prompt.userText);
      if (tokenCount > maxInputTokensForCall) {
        throw new Error(
          `Input token count (${formatCompactCount(tokenCount)}) exceeds model input limit (${formatCompactCount(maxInputTokensForCall)}). Tokenized with GPT tokenizer; prompt included.`,
        );
      }
    }

    const request = {
      modelId: parsedModelEffective.canonical,
      prompt,
      temperature: 0,
      maxOutputTokens: maxOutputTokensForCall ?? undefined,
      timeoutMs: deps.timeoutMs,
      fetchImpl: deps.trackedFetch,
      apiKeys: apiKeysForLlm,
      forceOpenRouter: attempt.forceOpenRouter,
      openaiBaseUrlOverride: attempt.openaiBaseUrlOverride ?? providerRuntime.baseUrls.openai,
      anthropicBaseUrlOverride: providerRuntime.baseUrls.anthropic,
      googleBaseUrlOverride: providerRuntime.baseUrls.google,
      xaiBaseUrlOverride: providerRuntime.baseUrls.xai,
      ollamaBaseUrlOverride: providerRuntime.baseUrls.ollama,
      forceChatCompletions,
      requestOptions,
    };
    const toResult = (summary: string, summaryEmitted = false): SummaryAttemptResult => ({
      summary,
      summaryEmitted,
      modelMeta: {
        provider: parsedModelEffective.provider,
        canonical: attempt.userModelId.toLowerCase().startsWith("openrouter/")
          ? attempt.userModelId
          : parsedModelEffective.canonical,
      },
      maxOutputTokensForCall: maxOutputTokensForCall ?? null,
    });
    const complete = async (retries = deps.retries) => {
      const result = await generateTextWithModelId({
        ...request,
        zaiBaseUrlOverride: providerRuntime.baseUrls.zai,
        retries,
        onRetry: createRetryLogger(parsedModelEffective.canonical),
      });
      deps.llmCalls.push({
        provider: result.provider,
        model: result.canonicalModelId,
        usage: result.usage,
        purpose: "summary",
      });
      const summary = result.text.trim();
      if (!summary) throw new Error("LLM returned an empty summary");
      return summary;
    };
    if (!streamingEnabledForCall) return toResult(await complete());

    let stream: Awaited<ReturnType<typeof streamTextWithModelId>>;
    let consumed: Pick<SummaryAttemptResult, "summary" | "summaryEmitted">;
    try {
      deps.trace?.("summary:stream-open");
      stream = await streamTextWithModelId(request);
      consumed = await consumeSummaryStream(stream, streamHandler, deps.trace);
    } catch (error) {
      if (hasEngineErrorCode(error, "SUMMARY_STREAM_INTERRUPTED")) throw error;
      const timedOut = isStreamingTimeoutError(error);
      const retryable = isRetryableLlmError(error);
      const unsupported =
        parsedModelEffective.provider === "google" && isGoogleStreamingUnsupportedError(error);
      if (!timedOut && !(deps.retries > 0 && retryable) && !unsupported) throw error;
      deps.log?.(
        timedOut
          ? `Streaming timed out for ${request.modelId}; falling back to non-streaming.`
          : retryable
            ? `Transient streaming failure for ${request.modelId}; retrying non-streaming.`
            : `Google model ${request.modelId} rejected streamGenerateContent; falling back to non-streaming.`,
      );
      const summary = await complete(retryable ? Math.max(0, deps.retries - 1) : deps.retries);
      if (!streamHandler) return toResult(summary);
      try {
        const chunkEmitted = await streamHandler.onChunk({
          streamed: summary,
          prevStreamed: "",
          appended: summary,
        });
        const finalEmitted = (await streamHandler.onDone?.(summary)) ?? false;
        return toResult(summary, chunkEmitted || finalEmitted);
      } catch (outputError) {
        throw streamInterrupted(outputError);
      }
    }
    const usage = await stream.usage;
    deps.llmCalls.push({
      provider: stream.provider,
      model: stream.canonicalModelId,
      usage,
      purpose: "summary",
    });
    return toResult(consumed.summary, consumed.summaryEmitted);
  };

  return {
    envHasKeyFor,
    formatMissingModelError,
    providerRuntime,
    runSummaryAttempt,
  };
}
