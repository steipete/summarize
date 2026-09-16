import type { BrowserAiSummaryInput } from "../../lib/panel-contracts";

export type BrowserAiAvailability = "available" | "downloadable" | "downloading" | "unavailable";

export type BrowserSummarizerSession = {
  inputQuota?: number;
  measureInputUsage?: (input: string, options?: { context?: string }) => Promise<number>;
  summarize: (
    input: string,
    options?: { context?: string; signal?: AbortSignal },
  ) => Promise<string>;
  destroy?: () => void;
};

export type BrowserSummarizerApi = {
  availability: () => Promise<BrowserAiAvailability>;
  create: (options: {
    type: "key-points";
    format: "plain-text";
    length: BrowserAiSummaryInput["length"];
    monitor: (monitor: EventTarget) => void;
  }) => Promise<BrowserSummarizerSession>;
};

export type BrowserLanguageModelPromptOptions = {
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

export type BrowserLanguageModelSession = {
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

export type BrowserLanguageModelCreateOptions = {
  expectedInputs: Array<{ type: "text"; languages: ["en"] } | { type: "image" }>;
  expectedOutputs: Array<{ type: "text"; languages: ["en"] }>;
};

export type BrowserLanguageModelApi = {
  availability: (options: BrowserLanguageModelCreateOptions) => Promise<BrowserAiAvailability>;
  create: (
    options: BrowserLanguageModelCreateOptions & {
      monitor: (monitor: EventTarget) => void;
    },
  ) => Promise<BrowserLanguageModelSession>;
};

export function buildLanguageModelOptions(imageInput: boolean): BrowserLanguageModelCreateOptions {
  return {
    expectedInputs: [
      { type: "text", languages: ["en"] },
      ...(imageInput ? ([{ type: "image" }] as const) : []),
    ],
    expectedOutputs: [{ type: "text", languages: ["en"] }],
  };
}

export function promptUsesImages(input: BrowserAiPromptInput): boolean {
  return (
    typeof input !== "string" &&
    input.some((message) => message.content.some((content) => content.type === "image"))
  );
}

export function promptTextLength(input: BrowserAiPromptInput): number {
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

export function defaultGetSummarizerApi(): BrowserSummarizerApi | null {
  const api = (globalThis as typeof globalThis & { Summarizer?: BrowserSummarizerApi }).Summarizer;
  return api && typeof api.availability === "function" && typeof api.create === "function"
    ? api
    : null;
}

export function defaultGetLanguageModelApi(): BrowserLanguageModelApi | null {
  const api = (
    globalThis as typeof globalThis & {
      LanguageModel?: BrowserLanguageModelApi;
    }
  ).LanguageModel;
  return api && typeof api.availability === "function" && typeof api.create === "function"
    ? api
    : null;
}

export function defaultIsUserActive(): boolean {
  return Boolean(
    (
      navigator as Navigator & {
        userActivation?: { isActive?: boolean };
      }
    ).userActivation?.isActive,
  );
}

export function isBrowserAiQuotaError(error: unknown): boolean {
  if (error instanceof DOMException && error.name === "QuotaExceededError") return true;
  if ((error as { name?: unknown } | null)?.name === "QuotaExceededError") return true;
  const message = error instanceof Error ? error.message : String(error);
  // i18n-ignore: Native browser AI quota diagnostics, not translated UI text.
  return /context window|input quota|quota exceeded/i.test(message);
}

export function browserAiErrorDetail(error: unknown) {
  return {
    error: error instanceof Error ? error.message : String(error),
    errorName: (error as { name?: unknown } | null)?.name,
  };
}
