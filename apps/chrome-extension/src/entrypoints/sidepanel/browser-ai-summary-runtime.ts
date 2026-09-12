import { logExtensionEvent } from "../../lib/extension-logs";
import type { BrowserAiSummaryInput } from "../../lib/panel-contracts";
import {
  browserAiErrorDetail,
  buildLanguageModelOptions,
  defaultGetLanguageModelApi,
  defaultGetSummarizerApi,
  defaultIsUserActive,
  isBrowserAiQuotaError,
  promptTextLength,
  promptUsesImages,
  type BrowserAiPromptInput,
  type BrowserLanguageModelApi,
  type BrowserLanguageModelPromptOptions,
  type BrowserLanguageModelSession,
  type BrowserSummarizerApi,
  type BrowserSummarizerSession,
} from "./browser-ai-contracts";
import { summarizeRecursively } from "./browser-ai-recursive-summary";

export type { BrowserAiPromptInput } from "./browser-ai-contracts";

type RuntimeOptions = {
  getApi?: () => BrowserSummarizerApi | null;
  getLanguageModelApi?: () => BrowserLanguageModelApi | null;
  isUserActive?: () => boolean;
  setStatus: (status: string) => void;
};

export type BrowserAiRequestKey = "summary" | "slides";
export type BrowserAiPromptResult =
  | {
      kind: "success";
      text: string;
      contextUsage: number | null;
      contextWindow: number | null;
    }
  | {
      kind: "too-large";
      contextUsage: number | null;
      contextWindow: number | null;
    };

export function createBrowserAiSummaryRuntime(options: RuntimeOptions) {
  const getApi = options.getApi ?? defaultGetSummarizerApi;
  const getLanguageModelApi = options.getLanguageModelApi ?? defaultGetLanguageModelApi;
  const isUserActive = options.isUserActive ?? defaultIsUserActive;
  const sessions = new Map<string, Promise<BrowserSummarizerSession | null>>();
  const promptSessions = new Map<string, Promise<BrowserLanguageModelSession | null>>();
  const activeControllers = new Map<BrowserAiRequestKey, AbortController>();
  let statusOwner: { requestKey: BrowserAiRequestKey; token: symbol } | null = null;

  const sessionKey = (requestKey: BrowserAiRequestKey, length: BrowserAiSummaryInput["length"]) =>
    `${requestKey}:${length}`;
  const promptSessionKey = (requestKey: BrowserAiRequestKey, imageInput: boolean) =>
    `${requestKey}:${imageInput ? "image" : "text"}`;
  const setOwnedStatus = (requestKey: BrowserAiRequestKey, owner: symbol, status: string) => {
    statusOwner = { requestKey, token: owner };
    options.setStatus(status);
  };
  const clearOwnedStatus = (owner: symbol) => {
    if (statusOwner?.token !== owner) return;
    statusOwner = null;
    options.setStatus("");
  };

  const createDownloadMonitor =
    (requestKey: BrowserAiRequestKey, statusToken: symbol) => (monitor: EventTarget) => {
      monitor.addEventListener("downloadprogress", (event) => {
        const loaded = (event as Event & { loaded?: number }).loaded;
        const percent =
          typeof loaded === "number" && Number.isFinite(loaded)
            ? ` ${Math.round(loaded * 100)}%`
            : "";
        setOwnedStatus(requestKey, statusToken, `Downloading on-device AI…${percent}`);
      });
    };

  const beginRequest = (requestKey: BrowserAiRequestKey, kind: "summary" | "prompt") => {
    activeControllers.get(requestKey)?.abort();
    const controller = new AbortController();
    activeControllers.set(requestKey, controller);
    const statusToken = Symbol(`browser-ai:${requestKey}:${kind}`);
    const isCurrent = () => activeControllers.get(requestKey) === controller;
    const finish = () => {
      if (!isCurrent()) return;
      activeControllers.delete(requestKey);
      clearOwnedStatus(statusToken);
    };
    return { controller, statusToken, isCurrent, finish };
  };

  const createSession = (
    api: BrowserSummarizerApi,
    length: BrowserAiSummaryInput["length"],
    requestKey: BrowserAiRequestKey,
    statusToken: symbol,
  ): Promise<BrowserSummarizerSession | null> => {
    const key = sessionKey(requestKey, length);
    const promise = api
      .create({
        type: "key-points",
        format: "plain-text",
        length,
        monitor: createDownloadMonitor(requestKey, statusToken),
      })
      .catch((error) => {
        logExtensionEvent({
          event: "browser-ai:create-error",
          level: "warn",
          scope: "sidepanel",
          detail: { length, requestKey, ...browserAiErrorDetail(error) },
        });
        sessions.delete(key);
        return null;
      });
    sessions.set(key, promise);
    return promise;
  };

  const ensureSession = async (
    length: BrowserAiSummaryInput["length"],
    requestKey: BrowserAiRequestKey,
    statusToken: symbol,
  ): Promise<BrowserSummarizerSession | null> => {
    const key = sessionKey(requestKey, length);
    const cached = sessions.get(key);
    if (cached) return await cached;
    const api = getApi();
    if (!api) return null;
    const availability = await api.availability().catch((error) => {
      logExtensionEvent({
        event: "browser-ai:availability-error",
        level: "warn",
        scope: "sidepanel",
        detail: browserAiErrorDetail(error),
      });
      return "unavailable" as const;
    });
    if (availability === "unavailable") return null;
    if (availability === "downloadable" && !isUserActive()) return null;
    return await createSession(api, length, requestKey, statusToken);
  };

  const createPromptSession = (
    api: BrowserLanguageModelApi,
    requestKey: BrowserAiRequestKey,
    imageInput: boolean,
    statusToken: symbol,
  ): Promise<BrowserLanguageModelSession | null> => {
    return api
      .create({
        ...buildLanguageModelOptions(imageInput),
        monitor: createDownloadMonitor(requestKey, statusToken),
      })
      .catch((error) => {
        logExtensionEvent({
          event: "browser-ai:prompt-create-error",
          level: "warn",
          scope: "sidepanel",
          detail: { imageInput, requestKey, ...browserAiErrorDetail(error) },
        });
        return null;
      });
  };

  const ensurePromptSession = async (
    requestKey: BrowserAiRequestKey,
    imageInput: boolean,
    statusToken: symbol,
  ): Promise<BrowserLanguageModelSession | null> => {
    const key = promptSessionKey(requestKey, imageInput);
    const cached = promptSessions.get(key);
    if (cached) {
      promptSessions.delete(key);
      return await cached;
    }
    const api = getLanguageModelApi();
    if (!api) return null;
    const availability = await api
      .availability(buildLanguageModelOptions(imageInput))
      .catch((error) => {
        logExtensionEvent({
          event: "browser-ai:prompt-availability-error",
          level: "warn",
          scope: "sidepanel",
          detail: { imageInput, ...browserAiErrorDetail(error) },
        });
        return "unavailable" as const;
      });
    if (availability === "unavailable") return null;
    if (availability === "downloadable" && !isUserActive()) return null;
    return await createPromptSession(api, requestKey, imageInput, statusToken);
  };

  const prepare = (
    length: BrowserAiSummaryInput["length"],
    requestKey: BrowserAiRequestKey = "summary",
  ) => {
    const key = sessionKey(requestKey, length);
    if (!isUserActive() || sessions.has(key)) return;
    const api = getApi();
    if (!api) return;
    const statusToken = Symbol(`browser-ai:${requestKey}:prepare`);
    void createSession(api, length, requestKey, statusToken).then(() => {
      clearOwnedStatus(statusToken);
    });
  };

  const preparePrompt = (
    requestKey: BrowserAiRequestKey = "slides",
    options: { imageInput?: boolean } = {},
  ) => {
    const imageInput = options.imageInput === true;
    const key = promptSessionKey(requestKey, imageInput);
    if (!isUserActive() || promptSessions.has(key)) return;
    const api = getLanguageModelApi();
    if (!api) return;
    const statusToken = Symbol(`browser-ai:${requestKey}:prompt-prepare`);
    const promise = createPromptSession(api, requestKey, imageInput, statusToken);
    promptSessions.set(key, promise);
    void promise.then((session) => {
      if (!session && promptSessions.get(key) === promise) promptSessions.delete(key);
      clearOwnedStatus(statusToken);
    });
  };

  const cancel = (requestKey?: BrowserAiRequestKey) => {
    const requestKeys = requestKey
      ? [requestKey]
      : (["summary", "slides"] satisfies BrowserAiRequestKey[]);
    for (const key of requestKeys) {
      activeControllers.get(key)?.abort();
      activeControllers.delete(key);
    }
    if (!requestKey || statusOwner?.requestKey === requestKey) {
      statusOwner = null;
      options.setStatus("");
    }
  };

  const summarize = async ({
    input,
    context,
    requestKey = "summary",
    status = "Summarizing with on-device AI…",
  }: {
    input: BrowserAiSummaryInput;
    context?: string;
    requestKey?: BrowserAiRequestKey;
    status?: string;
  }): Promise<string | null> => {
    const { controller, statusToken, isCurrent, finish } = beginRequest(requestKey, "summary");
    const session = await ensureSession(input.length, requestKey, statusToken);
    if (!session || !isCurrent()) {
      finish();
      return null;
    }

    setOwnedStatus(requestKey, statusToken, status);
    logExtensionEvent({
      event: "browser-ai:summarize-start",
      level: "verbose",
      scope: "sidepanel",
      detail: { chars: input.text.length, length: input.length, requestKey },
    });
    try {
      const result = await summarizeRecursively({
        session,
        text: input.text,
        context,
        signal: controller.signal,
      });
      const summary = isCurrent() && result.trim() ? result.trim() : null;
      logExtensionEvent({
        event: summary ? "browser-ai:summarize-done" : "browser-ai:summarize-discarded",
        level: summary ? "verbose" : "warn",
        scope: "sidepanel",
        detail: {
          chars: input.text.length,
          requestKey,
          resultChars: result.trim().length,
        },
      });
      return summary;
    } catch (error) {
      logExtensionEvent({
        event: "browser-ai:summarize-error",
        level: controller.signal.aborted ? "verbose" : "warn",
        scope: "sidepanel",
        detail: {
          aborted: controller.signal.aborted,
          chars: input.text.length,
          length: input.length,
          requestKey,
          ...browserAiErrorDetail(error),
        },
      });
      return null;
    } finally {
      finish();
    }
  };

  const prompt = async ({
    input,
    responseConstraint,
    requestKey = "slides",
    status = "Summarizing with on-device AI…",
  }: {
    input: BrowserAiPromptInput;
    responseConstraint: RegExp;
    requestKey?: BrowserAiRequestKey;
    status?: string;
  }): Promise<BrowserAiPromptResult | null> => {
    const { controller, statusToken, isCurrent, finish } = beginRequest(requestKey, "prompt");
    const imageInput = promptUsesImages(input);
    const chars = promptTextLength(input);
    const session = await ensurePromptSession(requestKey, imageInput, statusToken);
    if (!session || !isCurrent()) {
      session?.destroy?.();
      finish();
      return null;
    }

    const promptOptions: BrowserLanguageModelPromptOptions = {
      responseConstraint,
      omitResponseConstraintInput: true,
      signal: controller.signal,
    };
    let contextUsage: number | null = null;
    const contextWindow =
      typeof session.contextWindow === "number" && Number.isFinite(session.contextWindow)
        ? session.contextWindow
        : null;
    setOwnedStatus(requestKey, statusToken, status);
    logExtensionEvent({
      event: "browser-ai:prompt-start",
      level: "verbose",
      scope: "sidepanel",
      detail: { chars, imageInput, requestKey },
    });
    try {
      if (session.measureContextUsage) {
        contextUsage = await session.measureContextUsage(input, {
          responseConstraint,
          omitResponseConstraintInput: true,
        });
        if (
          contextWindow != null &&
          Number.isFinite(contextUsage) &&
          contextUsage > Math.floor(contextWindow * 0.85)
        ) {
          return { kind: "too-large", contextUsage, contextWindow };
        }
      }
      const result = await session.prompt(input, promptOptions);
      const text = isCurrent() && result.trim() ? result.trim() : "";
      if (!text) return null;
      logExtensionEvent({
        event: "browser-ai:prompt-done",
        level: "verbose",
        scope: "sidepanel",
        detail: {
          chars,
          contextUsage,
          contextWindow,
          imageInput,
          requestKey,
          resultChars: text.length,
        },
      });
      return { kind: "success", text, contextUsage, contextWindow };
    } catch (error) {
      if (isBrowserAiQuotaError(error)) {
        return { kind: "too-large", contextUsage, contextWindow };
      }
      logExtensionEvent({
        event: "browser-ai:prompt-error",
        level: controller.signal.aborted ? "verbose" : "warn",
        scope: "sidepanel",
        detail: {
          aborted: controller.signal.aborted,
          chars,
          imageInput,
          requestKey,
          ...browserAiErrorDetail(error),
        },
      });
      return null;
    } finally {
      session.destroy?.();
      finish();
    }
  };

  const destroy = () => {
    cancel();
    for (const sessionPromise of sessions.values()) {
      void sessionPromise.then((session) => session?.destroy?.());
    }
    for (const sessionPromise of promptSessions.values()) {
      void sessionPromise.then((session) => session?.destroy?.());
    }
    sessions.clear();
    promptSessions.clear();
  };

  return { cancel, destroy, prepare, preparePrompt, prompt, summarize };
}
