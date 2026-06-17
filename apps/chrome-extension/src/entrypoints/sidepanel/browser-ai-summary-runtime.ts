import { logExtensionEvent } from "../../lib/extension-logs";
import type { BrowserAiSummaryInput } from "../../lib/panel-contracts";

type BrowserAiAvailability = "available" | "downloadable" | "downloading" | "unavailable";

type BrowserSummarizerSession = {
  inputQuota?: number;
  measureInputUsage?: (input: string, options?: { context?: string }) => Promise<number>;
  summarize: (
    input: string,
    options?: { context?: string; signal?: AbortSignal },
  ) => Promise<string>;
  destroy?: () => void;
};

type BrowserSummarizerApi = {
  availability: () => Promise<BrowserAiAvailability>;
  create: (options: {
    type: "key-points";
    format: "plain-text";
    length: BrowserAiSummaryInput["length"];
    monitor: (monitor: EventTarget) => void;
  }) => Promise<BrowserSummarizerSession>;
};

type BrowserLanguageModelPromptOptions = {
  responseConstraint: RegExp;
  omitResponseConstraintInput: true;
  signal?: AbortSignal;
};

type BrowserLanguageModelContent = { type: "text"; value: string } | { type: "image"; value: Blob };

type BrowserLanguageModelMessage = {
  role: "user";
  content: BrowserLanguageModelContent[];
};

export type BrowserAiPromptInput = string | BrowserLanguageModelMessage[];

type BrowserLanguageModelSession = {
  contextWindow?: number;
  measureContextUsage?: (
    input: BrowserAiPromptInput,
    options: Omit<BrowserLanguageModelPromptOptions, "signal">,
  ) => Promise<number>;
  prompt: (
    input: BrowserAiPromptInput,
    options: BrowserLanguageModelPromptOptions,
  ) => Promise<string>;
  destroy?: () => void;
};

type BrowserLanguageModelApi = {
  availability: (options: BrowserLanguageModelCreateOptions) => Promise<BrowserAiAvailability>;
  create: (
    options: BrowserLanguageModelCreateOptions & {
      monitor: (monitor: EventTarget) => void;
    },
  ) => Promise<BrowserLanguageModelSession>;
};

type BrowserLanguageModelCreateOptions = {
  expectedInputs: Array<{ type: "text"; languages: ["en"] } | { type: "image" }>;
  expectedOutputs: Array<{ type: "text"; languages: ["en"] }>;
};

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

function buildLanguageModelOptions(imageInput: boolean): BrowserLanguageModelCreateOptions {
  return {
    expectedInputs: [
      { type: "text", languages: ["en"] },
      ...(imageInput ? ([{ type: "image" }] as const) : []),
    ],
    expectedOutputs: [{ type: "text", languages: ["en"] }],
  };
}

function promptUsesImages(input: BrowserAiPromptInput): boolean {
  return (
    typeof input !== "string" &&
    input.some((message) => message.content.some((content) => content.type === "image"))
  );
}

function promptTextLength(input: BrowserAiPromptInput): number {
  if (typeof input === "string") return input.length;
  return input.reduce(
    (total, message) =>
      total +
      message.content.reduce(
        (contentTotal, content) =>
          contentTotal + (content.type === "text" ? content.value.length : 0),
        0,
      ),
    0,
  );
}

function defaultGetApi(): BrowserSummarizerApi | null {
  const api = (globalThis as typeof globalThis & { Summarizer?: BrowserSummarizerApi }).Summarizer;
  return api && typeof api.availability === "function" && typeof api.create === "function"
    ? api
    : null;
}

function defaultGetLanguageModelApi(): BrowserLanguageModelApi | null {
  const api = (
    globalThis as typeof globalThis & {
      LanguageModel?: BrowserLanguageModelApi;
    }
  ).LanguageModel;
  return api && typeof api.availability === "function" && typeof api.create === "function"
    ? api
    : null;
}

function defaultIsUserActive(): boolean {
  return Boolean(
    (
      navigator as Navigator & {
        userActivation?: { isActive?: boolean };
      }
    ).userActivation?.isActive,
  );
}

function isQuotaError(error: unknown): boolean {
  if (error instanceof DOMException && error.name === "QuotaExceededError") return true;
  if ((error as { name?: unknown } | null)?.name === "QuotaExceededError") return true;
  const message = error instanceof Error ? error.message : String(error);
  return /context window|input quota|quota exceeded/i.test(message);
}

function errorDetail(error: unknown) {
  return {
    error: error instanceof Error ? error.message : String(error),
    errorName: (error as { name?: unknown } | null)?.name,
  };
}

function splitLongUnit(value: string, target: number): string[] {
  const words = value.split(/\s+/).filter(Boolean);
  if (words.length <= 1) {
    return Array.from({ length: Math.ceil(value.length / target) }, (_unused, index) =>
      value.slice(index * target, (index + 1) * target),
    );
  }
  const chunks: string[] = [];
  let current = "";
  for (const word of words) {
    if (word.length > target) {
      if (current) chunks.push(current);
      current = "";
      chunks.push(...splitLongUnit(word, target));
      continue;
    }
    const next = current ? `${current} ${word}` : word;
    if (next.length > target && current) {
      chunks.push(current);
      current = word;
    } else {
      current = next;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

function splitNear(value: string, maxChars: number): string[] {
  const target = Math.max(1, Math.floor(maxChars));
  if (value.length <= target) return [value];
  const units = value
    .split(/\n{2,}|(?<=[.!?])\s+/)
    .map((part) => part.trim())
    .filter(Boolean);
  const chunks: string[] = [];
  let current = "";
  const flush = () => {
    if (!current) return;
    chunks.push(current);
    current = "";
  };

  for (const unit of units) {
    if (unit.length > target) {
      flush();
      chunks.push(...splitLongUnit(unit, target));
      continue;
    }
    const next = current ? `${current} ${unit}` : unit;
    if (next.length > target) flush();
    current = current ? `${current} ${unit}` : unit;
  }
  flush();
  return chunks.length > 1 ? chunks : [value.slice(0, target), value.slice(target)];
}

async function summarizeRecursively({
  session,
  text,
  context,
  signal,
  depth,
}: {
  session: BrowserSummarizerSession;
  text: string;
  context?: string;
  signal?: AbortSignal;
  depth: number;
}): Promise<string> {
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
  if (depth > 8)
    throw new DOMException("Input exceeds the on-device context window", "QuotaExceededError");

  const inputQuota = session.inputQuota;
  if (
    typeof inputQuota === "number" &&
    Number.isFinite(inputQuota) &&
    inputQuota > 0 &&
    session.measureInputUsage
  ) {
    const usage = await session.measureInputUsage(text, context ? { context } : undefined);
    if (usage <= inputQuota) {
      return await session.summarize(text, { context, signal });
    }
    const targetChars = Math.max(1_000, Math.floor((text.length * inputQuota * 0.8) / usage));
    const chunks = splitNear(text, Math.min(targetChars, Math.ceil(text.length / 2)));
    const partials: string[] = [];
    for (const chunk of chunks) {
      partials.push(
        await summarizeRecursively({
          session,
          text: chunk,
          context,
          signal,
          depth: depth + 1,
        }),
      );
    }
    return await summarizeRecursively({
      session,
      text: partials.join("\n"),
      context,
      signal,
      depth: depth + 1,
    });
  }

  try {
    return await session.summarize(text, { context, signal });
  } catch (error) {
    if (!isQuotaError(error) || text.length < 2_000) throw error;
    const partials: string[] = [];
    for (const chunk of splitNear(text, Math.ceil(text.length / 2))) {
      partials.push(
        await summarizeRecursively({
          session,
          text: chunk,
          context,
          signal,
          depth: depth + 1,
        }),
      );
    }
    return await summarizeRecursively({
      session,
      text: partials.join("\n"),
      context,
      signal,
      depth: depth + 1,
    });
  }
}

export function createBrowserAiSummaryRuntime(options: RuntimeOptions) {
  const getApi = options.getApi ?? defaultGetApi;
  const getLanguageModelApi = options.getLanguageModelApi ?? defaultGetLanguageModelApi;
  const isUserActive = options.isUserActive ?? defaultIsUserActive;
  const sessions = new Map<string, Promise<BrowserSummarizerSession | null>>();
  const promptSessions = new Map<string, Promise<BrowserLanguageModelSession | null>>();
  const activeRequests = new Map<BrowserAiRequestKey, number>();
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
        monitor(monitor) {
          monitor.addEventListener("downloadprogress", (event) => {
            const loaded = (event as Event & { loaded?: number }).loaded;
            const percent =
              typeof loaded === "number" && Number.isFinite(loaded)
                ? ` ${Math.round(loaded * 100)}%`
                : "";
            setOwnedStatus(requestKey, statusToken, `Downloading on-device AI…${percent}`);
          });
        },
      })
      .catch((error) => {
        logExtensionEvent({
          event: "browser-ai:create-error",
          level: "warn",
          scope: "sidepanel",
          detail: { length, requestKey, ...errorDetail(error) },
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
        detail: errorDetail(error),
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
    const key = promptSessionKey(requestKey, imageInput);
    const promise = api
      .create({
        ...buildLanguageModelOptions(imageInput),
        monitor(monitor) {
          monitor.addEventListener("downloadprogress", (event) => {
            const loaded = (event as Event & { loaded?: number }).loaded;
            const percent =
              typeof loaded === "number" && Number.isFinite(loaded)
                ? ` ${Math.round(loaded * 100)}%`
                : "";
            setOwnedStatus(requestKey, statusToken, `Downloading on-device AI…${percent}`);
          });
        },
      })
      .catch((error) => {
        logExtensionEvent({
          event: "browser-ai:prompt-create-error",
          level: "warn",
          scope: "sidepanel",
          detail: { imageInput, requestKey, ...errorDetail(error) },
        });
        promptSessions.delete(key);
        return null;
      });
    promptSessions.set(key, promise);
    return promise;
  };

  const ensurePromptSession = async (
    requestKey: BrowserAiRequestKey,
    imageInput: boolean,
    statusToken: symbol,
  ): Promise<BrowserLanguageModelSession | null> => {
    const key = promptSessionKey(requestKey, imageInput);
    const cached = promptSessions.get(key);
    if (cached) return await cached;
    const api = getLanguageModelApi();
    if (!api) return null;
    const availability = await api
      .availability(buildLanguageModelOptions(imageInput))
      .catch((error) => {
        logExtensionEvent({
          event: "browser-ai:prompt-availability-error",
          level: "warn",
          scope: "sidepanel",
          detail: { imageInput, ...errorDetail(error) },
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
    void createPromptSession(api, requestKey, imageInput, statusToken).then(() => {
      clearOwnedStatus(statusToken);
    });
  };

  const cancel = (requestKey?: BrowserAiRequestKey) => {
    const requestKeys = requestKey
      ? [requestKey]
      : (["summary", "slides"] satisfies BrowserAiRequestKey[]);
    for (const key of requestKeys) {
      activeRequests.set(key, (activeRequests.get(key) ?? 0) + 1);
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
    const request = (activeRequests.get(requestKey) ?? 0) + 1;
    activeRequests.set(requestKey, request);
    activeControllers.get(requestKey)?.abort();
    const controller = new AbortController();
    activeControllers.set(requestKey, controller);
    const statusToken = Symbol(`browser-ai:${requestKey}:${request}`);
    const session = await ensureSession(input.length, requestKey, statusToken);
    if (!session || request !== activeRequests.get(requestKey)) {
      if (request === activeRequests.get(requestKey)) {
        activeControllers.delete(requestKey);
        clearOwnedStatus(statusToken);
      }
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
        depth: 0,
      });
      const summary =
        request === activeRequests.get(requestKey) && result.trim() ? result.trim() : null;
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
          ...errorDetail(error),
        },
      });
      return null;
    } finally {
      if (request === activeRequests.get(requestKey)) {
        activeControllers.delete(requestKey);
        clearOwnedStatus(statusToken);
      }
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
    const request = (activeRequests.get(requestKey) ?? 0) + 1;
    activeRequests.set(requestKey, request);
    activeControllers.get(requestKey)?.abort();
    const controller = new AbortController();
    activeControllers.set(requestKey, controller);
    const statusToken = Symbol(`browser-ai:${requestKey}:prompt:${request}`);
    const imageInput = promptUsesImages(input);
    const key = promptSessionKey(requestKey, imageInput);
    const chars = promptTextLength(input);
    const session = await ensurePromptSession(requestKey, imageInput, statusToken);
    if (!session || request !== activeRequests.get(requestKey)) {
      if (request === activeRequests.get(requestKey)) {
        activeControllers.delete(requestKey);
        clearOwnedStatus(statusToken);
      }
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
      const text = request === activeRequests.get(requestKey) && result.trim() ? result.trim() : "";
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
      if (isQuotaError(error)) {
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
          ...errorDetail(error),
        },
      });
      return null;
    } finally {
      session.destroy?.();
      const cached = promptSessions.get(key);
      if (cached && (await cached) === session) {
        promptSessions.delete(key);
      }
      if (request === activeRequests.get(requestKey)) {
        activeControllers.delete(requestKey);
        clearOwnedStatus(statusToken);
      }
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
