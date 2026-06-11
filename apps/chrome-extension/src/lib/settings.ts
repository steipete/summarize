import {
  type ColorMode,
  type ColorScheme,
  defaultColorMode,
  defaultColorScheme,
  normalizeColorMode,
  normalizeColorScheme,
} from "./theme";

export type Settings = {
  token: string;
  autoSummarize: boolean;
  hoverSummaries: boolean;
  chatEnabled: boolean;
  automationEnabled: boolean;
  slidesEnabled: boolean;
  slideRuntime: SlideRuntime;
  slidesParallel: boolean;
  slidesOcrEnabled: boolean;
  slidesLayout: SlidesLayout;
  summaryTimestamps: boolean;
  extendedLogging: boolean;
  autoCliFallback: boolean;
  autoCliOrder: string;
  hoverPrompt: string;
  transcriber: string;
  model: string;
  length: string;
  language: string;
  promptOverride: string;
  maxChars: number;
  requestMode: string;
  firecrawlMode: string;
  markdownMode: string;
  preprocessMode: string;
  youtubeMode: string;
  timeout: string;
  retries: number | null;
  maxOutputTokens: string;
  fontFamily: string;
  fontSize: number;
  lineHeight: number;
  colorScheme: ColorScheme;
  colorMode: ColorMode;
};

export type SlidesLayout = "strip" | "gallery";
export type SlideRuntime = "browser" | "daemon";

const storageKey = "settings";
const fallbackStorageKey = "summarize.settings";

function getLocalStorageArea(): chrome.storage.StorageArea | null {
  return globalThis.chrome?.storage?.local ?? null;
}

function loadFallbackSettings(): Record<string, unknown> {
  try {
    const raw = globalThis.localStorage?.getItem(fallbackStorageKey);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function saveFallbackSettings(settings: Settings): void {
  try {
    globalThis.localStorage?.setItem(fallbackStorageKey, JSON.stringify(settings));
  } catch {
    // Best-effort fallback for non-extension previews.
  }
}
const COUNT_PATTERN = /^(?<value>\d+(?:\.\d+)?)(?<unit>k|m)?$/i;
const DURATION_PATTERN = /^(?<value>\d+(?:\.\d+)?)(?<unit>ms|s|m|h)?$/i;
const MIN_MAX_CHARS = 20_000;
export const MAX_MAX_CHARS = 2_000_000;
const MIN_MAX_OUTPUT_TOKENS = 16;
const MIN_FONT_SIZE = 12;
const MAX_FONT_SIZE = 20;

const legacyFontFamilyMap = new Map<string, string>([
  [
    '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", system-ui, sans-serif',
    '-apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif',
  ],
]);

function normalizeFontFamily(value: unknown): string {
  if (typeof value !== "string") return defaultSettings.fontFamily;
  const trimmed = value.trim();
  if (!trimmed) return defaultSettings.fontFamily;
  return legacyFontFamilyMap.get(trimmed) ?? trimmed;
}

function normalizeModel(value: unknown): string {
  if (typeof value !== "string") return defaultSettings.model;
  const trimmed = value.trim();
  if (!trimmed) return defaultSettings.model;
  const lowered = trimmed.toLowerCase();
  if (lowered === "auto" || lowered === "free") return lowered;
  return trimmed;
}

function normalizeLength(value: unknown): string {
  if (typeof value !== "string") return defaultSettings.length;
  const trimmed = value.trim();
  if (!trimmed) return defaultSettings.length;
  const lowered = trimmed.toLowerCase();
  if (lowered === "s") return "short";
  if (lowered === "m") return "medium";
  if (lowered === "l") return "long";
  return lowered;
}

function normalizeLanguage(value: unknown): string {
  if (typeof value !== "string") return defaultSettings.language;
  const trimmed = value.trim();
  if (!trimmed) return defaultSettings.language;
  return trimmed;
}

function normalizePromptOverride(value: unknown): string {
  if (typeof value !== "string") return defaultSettings.promptOverride;
  return value;
}

function normalizeHoverPrompt(value: unknown): string {
  if (typeof value !== "string") return defaultSettings.hoverPrompt;
  const trimmed = value.trim();
  if (!trimmed) return defaultSettings.hoverPrompt;
  return value;
}

function normalizeAutoCliOrder(value: unknown): string {
  const source =
    typeof value === "string"
      ? value
      : Array.isArray(value)
        ? value.filter((entry): entry is string => typeof entry === "string").join(",")
        : defaultSettings.autoCliOrder;
  const items = source
    .split(/[,\s]+/)
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
  const out: string[] = [];
  for (const item of items) {
    if (
      item !== "claude" &&
      item !== "gemini" &&
      item !== "codex" &&
      item !== "agent" &&
      item !== "openclaw" &&
      item !== "opencode" &&
      item !== "copilot" &&
      item !== "agy" &&
      item !== "pi"
    ) {
      continue;
    }
    if (!out.includes(item)) out.push(item);
  }
  return out.length > 0 ? out.join(",") : defaultSettings.autoCliOrder;
}

function normalizeTranscriber(value: unknown): string {
  if (typeof value !== "string") return defaultSettings.transcriber;
  const trimmed = value.trim().toLowerCase();
  if (!trimmed) return defaultSettings.transcriber;
  if (trimmed === "whisper" || trimmed === "parakeet" || trimmed === "canary") return trimmed;
  return defaultSettings.transcriber;
}

function normalizeRequestMode(value: unknown): string {
  if (typeof value !== "string") return defaultSettings.requestMode;
  const trimmed = value.trim().toLowerCase();
  if (!trimmed) return defaultSettings.requestMode;
  if (trimmed === "page" || trimmed === "url") return trimmed;
  return defaultSettings.requestMode;
}

function normalizeSlidesLayout(value: unknown): SlidesLayout {
  if (typeof value !== "string") return defaultSettings.slidesLayout;
  const trimmed = value.trim().toLowerCase();
  if (trimmed === "strip" || trimmed === "summary") return "strip";
  if (trimmed === "gallery" || trimmed === "slides") return "gallery";
  return defaultSettings.slidesLayout;
}

function normalizeSlideRuntime(value: unknown, raw?: Record<string, unknown>): SlideRuntime {
  if (typeof value === "string") {
    const trimmed = value.trim().toLowerCase();
    if (trimmed === "browser" || trimmed === "daemon") return trimmed;
  }
  const legacyDaemonlessSlides = raw?.daemonlessSlides;
  if (typeof legacyDaemonlessSlides === "boolean") {
    return legacyDaemonlessSlides ? "browser" : "daemon";
  }
  return defaultSettings.slideRuntime;
}

function normalizeFirecrawlMode(value: unknown): string {
  if (typeof value !== "string") return defaultSettings.firecrawlMode;
  const trimmed = value.trim().toLowerCase();
  if (!trimmed) return defaultSettings.firecrawlMode;
  if (trimmed === "off" || trimmed === "auto" || trimmed === "always") return trimmed;
  return defaultSettings.firecrawlMode;
}

function normalizeMarkdownMode(value: unknown): string {
  if (typeof value !== "string") return defaultSettings.markdownMode;
  const trimmed = value.trim().toLowerCase();
  if (!trimmed) return defaultSettings.markdownMode;
  if (trimmed === "off" || trimmed === "auto" || trimmed === "llm" || trimmed === "readability") {
    return trimmed;
  }
  return defaultSettings.markdownMode;
}

function normalizePreprocessMode(value: unknown): string {
  if (typeof value !== "string") return defaultSettings.preprocessMode;
  const trimmed = value.trim().toLowerCase();
  if (!trimmed) return defaultSettings.preprocessMode;
  if (trimmed === "off" || trimmed === "auto" || trimmed === "always") return trimmed;
  return defaultSettings.preprocessMode;
}

function normalizeYoutubeMode(value: unknown): string {
  if (typeof value !== "string") return defaultSettings.youtubeMode;
  const trimmed = value.trim().toLowerCase();
  if (!trimmed) return defaultSettings.youtubeMode;
  if (
    trimmed === "auto" ||
    trimmed === "web" ||
    trimmed === "apify" ||
    trimmed === "yt-dlp" ||
    trimmed === "no-auto"
  ) {
    return trimmed;
  }
  return defaultSettings.youtubeMode;
}

function normalizeTimeout(value: unknown): string {
  if (typeof value !== "string") return defaultSettings.timeout;
  const trimmed = value.trim();
  if (!trimmed) return defaultSettings.timeout;
  const match = DURATION_PATTERN.exec(trimmed);
  if (!match?.groups) return defaultSettings.timeout;
  const numeric = Number(match.groups.value);
  if (!Number.isFinite(numeric) || numeric <= 0) return defaultSettings.timeout;
  return trimmed;
}

function normalizeRetries(value: unknown): number | null {
  if (value == null || value === "") return defaultSettings.retries;
  const numeric =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number(value.trim())
        : Number.NaN;
  if (!Number.isFinite(numeric)) return defaultSettings.retries;
  const intValue = Math.trunc(numeric);
  if (intValue < 0 || intValue > 5) return defaultSettings.retries;
  return intValue;
}

function normalizeMaxOutputTokens(value: unknown): string {
  if (typeof value !== "string") return defaultSettings.maxOutputTokens;
  const trimmed = value.trim().toLowerCase();
  if (!trimmed) return defaultSettings.maxOutputTokens;
  const match = COUNT_PATTERN.exec(trimmed);
  if (!match?.groups) return defaultSettings.maxOutputTokens;
  const numeric = Number(match.groups.value);
  if (!Number.isFinite(numeric) || numeric <= 0) return defaultSettings.maxOutputTokens;
  const unit = match.groups.unit?.toLowerCase() ?? null;
  const multiplier = unit === "k" ? 1000 : unit === "m" ? 1_000_000 : 1;
  const tokens = Math.floor(numeric * multiplier);
  if (tokens < MIN_MAX_OUTPUT_TOKENS) return defaultSettings.maxOutputTokens;
  return trimmed;
}

function normalizeMaxChars(value: unknown): number {
  const numeric =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number(value.trim())
        : Number.NaN;
  if (!Number.isFinite(numeric)) return defaultSettings.maxChars;
  const intValue = Math.floor(numeric);
  if (intValue < MIN_MAX_CHARS || intValue > MAX_MAX_CHARS) return defaultSettings.maxChars;
  return intValue;
}

function normalizeFontSize(value: unknown): number {
  const numeric =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number(value.trim())
        : Number.NaN;
  if (!Number.isFinite(numeric)) return defaultSettings.fontSize;
  const intValue = Math.round(numeric);
  if (intValue < MIN_FONT_SIZE || intValue > MAX_FONT_SIZE) return defaultSettings.fontSize;
  return intValue;
}

function normalizeLineHeight(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return defaultSettings.lineHeight;
  if (value < 1.1 || value > 2.2) return defaultSettings.lineHeight;
  return Math.round(value * 100) / 100;
}

export const defaultSettings: Settings = {
  token: "",
  autoSummarize: true,
  hoverSummaries: false,
  chatEnabled: true,
  automationEnabled: false,
  slidesEnabled: true,
  slideRuntime: "browser",
  slidesParallel: true,
  slidesOcrEnabled: false,
  slidesLayout: "gallery",
  summaryTimestamps: true,
  extendedLogging: false,
  autoCliFallback: true,
  autoCliOrder: "claude,gemini,codex,agent,openclaw,opencode,copilot",
  hoverPrompt:
    "Plain text only (no Markdown). Summarize the linked page concisely in 1-2 sentences; aim for 100-200 characters.",
  transcriber: "",
  model: "auto",
  length: "xl",
  language: "auto",
  promptOverride: "",
  maxChars: 120_000,
  requestMode: "",
  firecrawlMode: "",
  markdownMode: "",
  preprocessMode: "",
  youtubeMode: "",
  timeout: "",
  retries: null,
  maxOutputTokens: "",
  fontFamily: '-apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif',
  fontSize: 14,
  lineHeight: 1.45,
  colorScheme: defaultColorScheme,
  colorMode: defaultColorMode,
};

export async function loadSettings(): Promise<Settings> {
  const storage = getLocalStorageArea();
  const res = storage
    ? await new Promise<Record<string, unknown>>((resolve, reject) => {
        let settled = false;
        const maybePromise = storage.get(storageKey, (result) => {
          settled = true;
          resolve(result as Record<string, unknown>);
        });
        if (maybePromise && typeof (maybePromise as Promise<unknown>).then === "function") {
          (maybePromise as Promise<Record<string, unknown>>)
            .then((result) => {
              if (settled) return;
              resolve(result as Record<string, unknown>);
            })
            .catch(reject);
        }
      })
    : { [storageKey]: loadFallbackSettings() };
  const raw = (res[storageKey] ?? {}) as Partial<Settings> & Record<string, unknown>;
  return {
    ...defaultSettings,
    ...raw,
    token: typeof raw.token === "string" ? raw.token : defaultSettings.token,
    model: normalizeModel(raw.model),
    length: normalizeLength(raw.length),
    language: normalizeLanguage(raw.language),
    promptOverride: normalizePromptOverride(raw.promptOverride),
    autoSummarize:
      typeof raw.autoSummarize === "boolean" ? raw.autoSummarize : defaultSettings.autoSummarize,
    hoverSummaries:
      typeof raw.hoverSummaries === "boolean" ? raw.hoverSummaries : defaultSettings.hoverSummaries,
    chatEnabled:
      typeof raw.chatEnabled === "boolean" ? raw.chatEnabled : defaultSettings.chatEnabled,
    automationEnabled:
      typeof raw.automationEnabled === "boolean"
        ? raw.automationEnabled
        : defaultSettings.automationEnabled,
    slidesEnabled:
      typeof raw.slidesEnabled === "boolean" ? raw.slidesEnabled : defaultSettings.slidesEnabled,
    slideRuntime: normalizeSlideRuntime(raw.slideRuntime, raw),
    slidesParallel:
      typeof raw.slidesParallel === "boolean" ? raw.slidesParallel : defaultSettings.slidesParallel,
    slidesOcrEnabled:
      typeof raw.slidesOcrEnabled === "boolean"
        ? raw.slidesOcrEnabled
        : defaultSettings.slidesOcrEnabled,
    slidesLayout: normalizeSlidesLayout(raw.slidesLayout),
    summaryTimestamps:
      typeof raw.summaryTimestamps === "boolean"
        ? raw.summaryTimestamps
        : defaultSettings.summaryTimestamps,
    extendedLogging:
      typeof raw.extendedLogging === "boolean"
        ? raw.extendedLogging
        : defaultSettings.extendedLogging,
    autoCliFallback:
      typeof raw.autoCliFallback === "boolean"
        ? raw.autoCliFallback
        : typeof (raw as Record<string, unknown>).magicCliAuto === "boolean"
          ? ((raw as Record<string, unknown>).magicCliAuto as boolean)
          : defaultSettings.autoCliFallback,
    autoCliOrder: normalizeAutoCliOrder(
      typeof raw.autoCliOrder !== "undefined"
        ? raw.autoCliOrder
        : (raw as Record<string, unknown>).magicCliOrder,
    ),
    hoverPrompt: normalizeHoverPrompt(raw.hoverPrompt),
    transcriber: normalizeTranscriber(raw.transcriber),
    maxChars: normalizeMaxChars(raw.maxChars),
    requestMode: normalizeRequestMode(raw.requestMode),
    firecrawlMode: normalizeFirecrawlMode(raw.firecrawlMode),
    markdownMode: normalizeMarkdownMode(raw.markdownMode),
    preprocessMode: normalizePreprocessMode(raw.preprocessMode),
    youtubeMode: normalizeYoutubeMode(raw.youtubeMode),
    timeout: normalizeTimeout(raw.timeout),
    retries: normalizeRetries(raw.retries),
    maxOutputTokens: normalizeMaxOutputTokens(raw.maxOutputTokens),
    fontFamily: normalizeFontFamily(raw.fontFamily),
    fontSize: normalizeFontSize(raw.fontSize),
    lineHeight: normalizeLineHeight(raw.lineHeight),
    colorScheme: normalizeColorScheme(raw.colorScheme),
    colorMode: normalizeColorMode(raw.colorMode),
  };
}

export async function saveSettings(settings: Settings): Promise<void> {
  const normalized = {
    ...settings,
    model: normalizeModel(settings.model),
    length: normalizeLength(settings.length),
    language: normalizeLanguage(settings.language),
    promptOverride: normalizePromptOverride(settings.promptOverride),
    hoverPrompt: normalizeHoverPrompt(settings.hoverPrompt),
    autoCliOrder: normalizeAutoCliOrder(settings.autoCliOrder),
    requestMode: normalizeRequestMode(settings.requestMode),
    slidesLayout: normalizeSlidesLayout(settings.slidesLayout),
    firecrawlMode: normalizeFirecrawlMode(settings.firecrawlMode),
    markdownMode: normalizeMarkdownMode(settings.markdownMode),
    preprocessMode: normalizePreprocessMode(settings.preprocessMode),
    youtubeMode: normalizeYoutubeMode(settings.youtubeMode),
    timeout: normalizeTimeout(settings.timeout),
    retries: normalizeRetries(settings.retries),
    maxOutputTokens: normalizeMaxOutputTokens(settings.maxOutputTokens),
    transcriber: normalizeTranscriber(settings.transcriber),
    fontFamily: normalizeFontFamily(settings.fontFamily),
    maxChars: normalizeMaxChars(settings.maxChars),
    fontSize: normalizeFontSize(settings.fontSize),
    lineHeight: normalizeLineHeight(settings.lineHeight),
    colorScheme: normalizeColorScheme(settings.colorScheme),
    colorMode: normalizeColorMode(settings.colorMode),
  };
  const storage = getLocalStorageArea();
  if (!storage) {
    saveFallbackSettings(normalized);
    return;
  }
  await storage.set({
    [storageKey]: {
      ...normalized,
    },
  });
}

export async function patchSettings(patch: Partial<Settings>): Promise<Settings> {
  const current = await loadSettings();
  const next = { ...current, ...patch };
  await saveSettings(next);
  return next;
}
