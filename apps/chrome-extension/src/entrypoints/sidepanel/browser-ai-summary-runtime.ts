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

type RuntimeOptions = {
  getApi?: () => BrowserSummarizerApi | null;
  isUserActive?: () => boolean;
  setStatus: (status: string) => void;
};

function defaultGetApi(): BrowserSummarizerApi | null {
  const api = (globalThis as typeof globalThis & { Summarizer?: BrowserSummarizerApi }).Summarizer;
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
  const isUserActive = options.isUserActive ?? defaultIsUserActive;
  const sessions = new Map<
    BrowserAiSummaryInput["length"],
    Promise<BrowserSummarizerSession | null>
  >();
  let activeRequest = 0;
  let activeController: AbortController | null = null;

  const createSession = (
    api: BrowserSummarizerApi,
    length: BrowserAiSummaryInput["length"],
  ): Promise<BrowserSummarizerSession | null> => {
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
            options.setStatus(`Downloading on-device AI…${percent}`);
          });
        },
      })
      .catch((error) => {
        logExtensionEvent({
          event: "browser-ai:create-error",
          level: "warn",
          scope: "sidepanel",
          detail: { length, ...errorDetail(error) },
        });
        sessions.delete(length);
        return null;
      });
    sessions.set(length, promise);
    return promise;
  };

  const ensureSession = async (
    length: BrowserAiSummaryInput["length"],
  ): Promise<BrowserSummarizerSession | null> => {
    const cached = sessions.get(length);
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
    return await createSession(api, length);
  };

  const prepare = (length: BrowserAiSummaryInput["length"]) => {
    if (!isUserActive() || sessions.has(length)) return;
    const api = getApi();
    if (!api) return;
    void createSession(api, length).then((session) => {
      if (!session) options.setStatus("");
    });
  };

  const cancel = () => {
    activeRequest += 1;
    activeController?.abort();
    activeController = null;
    options.setStatus("");
  };

  const summarize = async ({
    input,
    context,
  }: {
    input: BrowserAiSummaryInput;
    context?: string;
  }): Promise<string | null> => {
    const request = ++activeRequest;
    activeController?.abort();
    const controller = new AbortController();
    activeController = controller;
    const session = await ensureSession(input.length);
    if (!session || request !== activeRequest) {
      if (request === activeRequest) {
        activeController = null;
        options.setStatus("");
      }
      return null;
    }

    options.setStatus("Summarizing with on-device AI…");
    logExtensionEvent({
      event: "browser-ai:summarize-start",
      level: "verbose",
      scope: "sidepanel",
      detail: { chars: input.text.length, length: input.length },
    });
    try {
      const result = await summarizeRecursively({
        session,
        text: input.text,
        context,
        signal: controller.signal,
        depth: 0,
      });
      const summary = request === activeRequest && result.trim() ? result.trim() : null;
      logExtensionEvent({
        event: summary ? "browser-ai:summarize-done" : "browser-ai:summarize-discarded",
        level: summary ? "verbose" : "warn",
        scope: "sidepanel",
        detail: { chars: input.text.length, resultChars: result.trim().length },
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
          ...errorDetail(error),
        },
      });
      return null;
    } finally {
      if (request === activeRequest) {
        activeController = null;
        options.setStatus("");
      }
    }
  };

  const destroy = () => {
    cancel();
    for (const sessionPromise of sessions.values()) {
      void sessionPromise.then((session) => session?.destroy?.());
    }
    sessions.clear();
  };

  return { cancel, destroy, prepare, summarize };
}
