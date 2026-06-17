import type { CliProvider } from "../config.js";
import { isCliDisabled, runCliModel } from "../llm/cli.js";
import { streamTextWithModelId } from "../llm/generate-text.js";
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
import { EngineError } from "./errors.js";
import type { SummaryStreamHandler } from "./events.js";
import { resolveModelIdForLlmCall, summarizeWithModelId } from "./model-call.js";
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
  llmCalls: Array<{
    provider:
      | "xai"
      | "openai"
      | "google"
      | "anthropic"
      | "evolink"
      | "zai"
      | "nvidia"
      | "minimax"
      | "github-copilot"
      | "ollama"
      | "cli";
    model: string;
    usage: Awaited<ReturnType<typeof summarizeWithModelId>>["usage"] | null;
    costUsd?: number | null;
    purpose: "summary" | "markdown" | "speaker-identification";
  }>;
  log?: ((message: string) => void) | null;
  trace?: ((name: string, detail?: string | null) => void) | null;
  providerRuntime: ProviderRuntimeBindings;
  openrouterApiKey: string | null;
};

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
      !modelResolution.forceStreamOff &&
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

    if (!streamingEnabledForCall) {
      const result = await summarizeWithModelId({
        modelId: parsedModelEffective.canonical,
        prompt,
        maxOutputTokens: maxOutputTokensForCall ?? undefined,
        timeoutMs: deps.timeoutMs,
        fetchImpl: deps.trackedFetch,
        apiKeys: apiKeysForLlm,
        forceOpenRouter: attempt.forceOpenRouter,
        openaiBaseUrlOverride: attempt.openaiBaseUrlOverride ?? providerRuntime.baseUrls.openai,
        anthropicBaseUrlOverride: providerRuntime.baseUrls.anthropic,
        googleBaseUrlOverride: providerRuntime.baseUrls.google,
        xaiBaseUrlOverride: providerRuntime.baseUrls.xai,
        zaiBaseUrlOverride: providerRuntime.baseUrls.zai,
        ollamaBaseUrlOverride: providerRuntime.baseUrls.ollama,
        forceChatCompletions,
        requestOptions,
        retries: deps.retries,
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
      const displayCanonical = attempt.userModelId.toLowerCase().startsWith("openrouter/")
        ? attempt.userModelId
        : parsedModelEffective.canonical;
      return {
        summary,
        summaryEmitted: false,
        modelMeta: {
          provider: parsedModelEffective.provider,
          canonical: displayCanonical,
        },
        maxOutputTokensForCall: maxOutputTokensForCall ?? null,
      };
    }

    let summaryEmitted = false;
    let summary = "";
    let getLastStreamError: (() => unknown) | null = null;

    let streamResult: Awaited<ReturnType<typeof streamTextWithModelId>> | null = null;
    const summarizeWithoutStreaming = async () => {
      const result = await summarizeWithModelId({
        modelId: parsedModelEffective.canonical,
        prompt,
        maxOutputTokens: maxOutputTokensForCall ?? undefined,
        timeoutMs: deps.timeoutMs,
        fetchImpl: deps.trackedFetch,
        apiKeys: apiKeysForLlm,
        forceOpenRouter: attempt.forceOpenRouter,
        openaiBaseUrlOverride: attempt.openaiBaseUrlOverride ?? providerRuntime.baseUrls.openai,
        anthropicBaseUrlOverride: providerRuntime.baseUrls.anthropic,
        googleBaseUrlOverride: providerRuntime.baseUrls.google,
        xaiBaseUrlOverride: providerRuntime.baseUrls.xai,
        zaiBaseUrlOverride: providerRuntime.baseUrls.zai,
        ollamaBaseUrlOverride: providerRuntime.baseUrls.ollama,
        forceChatCompletions,
        requestOptions,
        retries: deps.retries,
        onRetry: createRetryLogger(parsedModelEffective.canonical),
      });
      deps.llmCalls.push({
        provider: result.provider,
        model: result.canonicalModelId,
        usage: result.usage,
        purpose: "summary",
      });
      return result.text;
    };
    const canFallbackFromStreamError = (error: unknown): boolean =>
      isStreamingTimeoutError(error) ||
      (parsedModelEffective.provider === "google" && isGoogleStreamingUnsupportedError(error));
    const writeStreamFallbackNotice = (error: unknown) => {
      if (isStreamingTimeoutError(error)) {
        deps.log?.(
          `Streaming timed out for ${parsedModelEffective.canonical}; falling back to non-streaming.`,
        );
        return;
      }
      deps.log?.(
        `Google model ${parsedModelEffective.canonical} rejected streamGenerateContent; falling back to non-streaming.`,
      );
    };
    const createStreamInterruptedError = (error: unknown) =>
      new EngineError(
        "SUMMARY_STREAM_INTERRUPTED",
        error instanceof Error ? error.message : "Summary stream failed after output",
        { cause: error },
      );
    try {
      deps.trace?.("summary:stream-open");
      streamResult = await streamTextWithModelId({
        modelId: parsedModelEffective.canonical,
        apiKeys: apiKeysForLlm,
        forceOpenRouter: attempt.forceOpenRouter,
        openaiBaseUrlOverride: attempt.openaiBaseUrlOverride ?? providerRuntime.baseUrls.openai,
        anthropicBaseUrlOverride: providerRuntime.baseUrls.anthropic,
        googleBaseUrlOverride: providerRuntime.baseUrls.google,
        xaiBaseUrlOverride: providerRuntime.baseUrls.xai,
        ollamaBaseUrlOverride: providerRuntime.baseUrls.ollama,
        forceChatCompletions,
        requestOptions,
        prompt,
        temperature: 0,
        maxOutputTokens: maxOutputTokensForCall ?? undefined,
        timeoutMs: deps.timeoutMs,
        fetchImpl: deps.trackedFetch,
      });
    } catch (error) {
      if (canFallbackFromStreamError(error)) {
        writeStreamFallbackNotice(error);
        summary = await summarizeWithoutStreaming();
        streamResult = null;
      } else {
        throw error;
      }
    }

    if (streamResult) {
      getLastStreamError = streamResult.lastError;
      let streamed = "";
      let streamedRaw = "";
      let streamCompleted = false;
      let streamHandlerStarted = false;
      let streamOutputEmitted = false;

      try {
        let sawFirstDelta = false;
        for await (const delta of streamResult.textStream) {
          if (!sawFirstDelta) {
            sawFirstDelta = true;
            deps.trace?.("summary:first-delta");
          }
          const prevStreamed = streamed;
          const merged = mergeStreamingChunk(streamed, delta);
          streamed = merged.next;
          if (streamHandler) {
            if (!streamHandlerStarted && !streamed.trim()) continue;
            const firstChunk = !streamHandlerStarted;
            streamHandlerStarted = true;
            streamOutputEmitted =
              (await streamHandler.onChunk({
                streamed: merged.next,
                prevStreamed: firstChunk ? "" : prevStreamed,
                appended: firstChunk ? merged.next : merged.appended,
              })) || streamOutputEmitted;
          }
        }

        const finalText = (await streamResult.finalText)?.trim() ?? "";
        if (finalText.length > streamed.length && finalText.startsWith(streamed)) {
          const prevStreamed = streamed;
          const firstChunk = !streamHandlerStarted;
          streamed = finalText;
          if (streamHandler) {
            streamHandlerStarted = true;
            streamOutputEmitted =
              (await streamHandler.onChunk({
                streamed,
                prevStreamed: firstChunk ? "" : prevStreamed,
                appended: firstChunk ? streamed : streamed.slice(prevStreamed.length),
              })) || streamOutputEmitted;
          }
        }

        streamedRaw = streamed;
        const trimmed = streamed.trim();
        streamed = trimmed;
        streamCompleted = true;
      } catch (error) {
        if (streamHandler && streamHandlerStarted && !streamOutputEmitted) {
          await streamHandler.onReset();
          streamHandlerStarted = false;
        }
        if (canFallbackFromStreamError(error) && !streamOutputEmitted) {
          writeStreamFallbackNotice(error);
          summary = await summarizeWithoutStreaming();
          streamResult = null;
        } else {
          throw streamOutputEmitted ? createStreamInterruptedError(error) : error;
        }
      } finally {
        if (streamCompleted && streamHandler && streamHandlerStarted) {
          try {
            const finalOutputEmitted =
              (await streamHandler.onDone?.(streamedRaw || streamed)) ?? false;
            summaryEmitted = streamOutputEmitted || finalOutputEmitted;
          } catch (error) {
            throw createStreamInterruptedError(error);
          }
        }
      }
      if (streamResult) {
        const usage = await streamResult.usage;
        deps.llmCalls.push({
          provider: streamResult.provider,
          model: streamResult.canonicalModelId,
          usage,
          purpose: "summary",
        });
        summary = streamed;
      }
    }

    summary = summary.trim();
    if (summary.length === 0) {
      const last = getLastStreamError?.();
      if (last instanceof Error) {
        throw new Error(last.message, { cause: last });
      }
      throw new Error("LLM returned an empty summary");
    }

    if (!streamResult && streamHandler) {
      const cleaned = summary.trim();
      const chunkEmitted = await streamHandler.onChunk({
        streamed: cleaned,
        prevStreamed: "",
        appended: cleaned,
      });
      const finalOutputEmitted = (await streamHandler.onDone?.(cleaned)) ?? false;
      summaryEmitted = chunkEmitted || finalOutputEmitted;
    }

    return {
      summary,
      summaryEmitted,
      modelMeta: {
        provider: parsedModelEffective.provider,
        canonical: attempt.userModelId.toLowerCase().startsWith("openrouter/")
          ? attempt.userModelId
          : parsedModelEffective.canonical,
      },
      maxOutputTokensForCall: maxOutputTokensForCall ?? null,
    };
  };

  return {
    envHasKeyFor,
    formatMissingModelError,
    providerRuntime,
    runSummaryAttempt,
  };
}
