import type { SummarizeRequestOverrides } from "@steipete/summarize-core/runtime";
import { enforceDaemonPolicy, readDaemonPolicy } from "./daemon-policy";
import { readStoredSettings, writeStoredSettings } from "./settings-storage";
import {
  type ColorMode,
  type ColorScheme,
  defaultColorMode,
  defaultColorScheme,
  normalizeColorMode,
  normalizeColorScheme,
} from "./theme";

type RequestModeSetting = "" | NonNullable<SummarizeRequestOverrides["mode"]>;
type FirecrawlModeSetting = "" | NonNullable<SummarizeRequestOverrides["firecrawl"]>;
type MarkdownModeSetting = "" | NonNullable<SummarizeRequestOverrides["markdownMode"]>;
type PreprocessModeSetting = "" | NonNullable<SummarizeRequestOverrides["preprocess"]>;
type YoutubeModeSetting = "" | NonNullable<SummarizeRequestOverrides["youtube"]>;
type TranscriberSetting = "" | NonNullable<SummarizeRequestOverrides["transcriber"]>;

export type Settings = {
  token: string;
  daemonPort: string;
  summaryRuntime: SummaryRuntime;
  provider: DirectProvider;
  providerApiKeys: Partial<Record<DirectProvider, string>>;
  providerBaseUrls: Partial<Record<DirectProvider, string>>;
  daemonHintDismissed: boolean;
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
  transcriber: TranscriberSetting;
  model: string;
  length: string;
  language: string;
  promptOverride: string;
  maxChars: number;
  requestMode: RequestModeSetting;
  firecrawlMode: FirecrawlModeSetting;
  markdownMode: MarkdownModeSetting;
  preprocessMode: PreprocessModeSetting;
  youtubeMode: YoutubeModeSetting;
  timeout: string;
  retries: number | null;
  maxOutputTokens: string;
  fontFamily: string;
  fontSize: number;
  lineHeight: number;
  colorScheme: ColorScheme;
  colorMode: ColorMode;
};

export type EffectiveSettings = Settings & {
  daemonAllowed: boolean;
  daemonManaged: boolean;
};

export type SlidesLayout = "strip" | "gallery";
export type SlideRuntime = "browser" | "daemon";
export type SummaryRuntime = "direct" | "daemon";
export type DirectProvider =
  | "openai"
  | "openrouter"
  | "anthropic"
  | "google"
  | "xai"
  | "zai"
  | "nvidia"
  | "minimax"
  | "github"
  | "ollama";

export type ProviderSettings = {
  provider: DirectProvider;
  apiKeys: Partial<Record<DirectProvider, string>>;
  baseUrls: Partial<Record<DirectProvider, string>>;
};

const COUNT_PATTERN = /^(?<value>\d+(?:\.\d+)?)(?<unit>k|m)?$/i;
const DURATION_PATTERN = /^(?<value>\d+(?:\.\d+)?)(?<unit>ms|s|m|h)?$/i;
const MIN_MAX_CHARS = 20_000;
export const MAX_MAX_CHARS = 2_000_000;
const MIN_MAX_OUTPUT_TOKENS = 16;
const MIN_FONT_SIZE = 12;
const MAX_FONT_SIZE = 20;
export const DEFAULT_DAEMON_PORT = "8787";

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

function normalizeModel(value: unknown, raw?: Record<string, unknown>): string {
  if (
    typeof raw?.summaryRuntime === "string" &&
    raw.summaryRuntime.trim().toLowerCase() === "browser"
  ) {
    return "browser/gemini-nano";
  }
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

function normalizeTranscriber(value: unknown): TranscriberSetting {
  if (typeof value !== "string") return defaultSettings.transcriber;
  const trimmed = value.trim().toLowerCase();
  if (!trimmed) return defaultSettings.transcriber;
  if (trimmed === "whisper" || trimmed === "parakeet" || trimmed === "canary") return trimmed;
  return defaultSettings.transcriber;
}

function normalizeRequestMode(value: unknown): RequestModeSetting {
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

function normalizeSummaryRuntime(value: unknown, raw?: Record<string, unknown>): SummaryRuntime {
  if (typeof value === "string") {
    const trimmed = value.trim().toLowerCase();
    if (trimmed === "daemon") return "daemon";
    if (trimmed === "browser" || trimmed === "direct") return "direct";
  }
  return normalizeSlideRuntime(raw?.slideRuntime, raw) === "daemon" ? "daemon" : "direct";
}

const directProviders = new Set<DirectProvider>([
  "openai",
  "openrouter",
  "anthropic",
  "google",
  "xai",
  "zai",
  "nvidia",
  "minimax",
  "github",
  "ollama",
]);

function normalizeProvider(value: unknown): DirectProvider {
  if (typeof value !== "string") return defaultSettings.provider;
  const normalized = value.trim().toLowerCase() as DirectProvider;
  return directProviders.has(normalized) ? normalized : defaultSettings.provider;
}

function normalizeProviderMap(value: unknown): Partial<Record<DirectProvider, string>> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: Partial<Record<DirectProvider, string>> = {};
  for (const provider of directProviders) {
    const entry = (value as Record<string, unknown>)[provider];
    if (typeof entry === "string") out[provider] = entry.trim();
  }
  return out;
}

function normalizeFirecrawlMode(value: unknown): FirecrawlModeSetting {
  if (typeof value !== "string") return defaultSettings.firecrawlMode;
  const trimmed = value.trim().toLowerCase();
  if (!trimmed) return defaultSettings.firecrawlMode;
  if (trimmed === "off" || trimmed === "auto" || trimmed === "always") return trimmed;
  return defaultSettings.firecrawlMode;
}

function normalizeMarkdownMode(value: unknown): MarkdownModeSetting {
  if (typeof value !== "string") return defaultSettings.markdownMode;
  const trimmed = value.trim().toLowerCase();
  if (!trimmed) return defaultSettings.markdownMode;
  if (trimmed === "off" || trimmed === "auto" || trimmed === "llm" || trimmed === "readability") {
    return trimmed;
  }
  return defaultSettings.markdownMode;
}

function normalizePreprocessMode(value: unknown): PreprocessModeSetting {
  if (typeof value !== "string") return defaultSettings.preprocessMode;
  const trimmed = value.trim().toLowerCase();
  if (!trimmed) return defaultSettings.preprocessMode;
  if (trimmed === "off" || trimmed === "auto" || trimmed === "always") return trimmed;
  return defaultSettings.preprocessMode;
}

function normalizeYoutubeMode(value: unknown): YoutubeModeSetting {
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

export function normalizeDaemonPort(value: unknown): string {
  if (typeof value !== "string" && typeof value !== "number") return DEFAULT_DAEMON_PORT;
  const trimmed = String(value).trim();
  if (!/^\d+$/.test(trimmed)) return DEFAULT_DAEMON_PORT;
  const port = Number(trimmed);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return DEFAULT_DAEMON_PORT;
  return String(port);
}

export const defaultSettings: Settings = {
  token: "",
  daemonPort: DEFAULT_DAEMON_PORT,
  summaryRuntime: "direct",
  provider: "openai",
  providerApiKeys: {},
  providerBaseUrls: {},
  daemonHintDismissed: false,
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
  length: "long",
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

export async function loadSettings(): Promise<EffectiveSettings> {
  const raw = (await readStoredSettings()) as Partial<Settings> & Record<string, unknown>;
  const normalized: Settings = {
    ...defaultSettings,
    ...raw,
    token: typeof raw.token === "string" ? raw.token : defaultSettings.token,
    daemonPort: normalizeDaemonPort(raw.daemonPort),
    summaryRuntime: normalizeSummaryRuntime(raw.summaryRuntime, raw),
    provider: normalizeProvider(raw.provider),
    providerApiKeys: normalizeProviderMap(raw.providerApiKeys),
    providerBaseUrls: normalizeProviderMap(raw.providerBaseUrls),
    daemonHintDismissed:
      typeof raw.daemonHintDismissed === "boolean"
        ? raw.daemonHintDismissed
        : defaultSettings.daemonHintDismissed,
    model: normalizeModel(raw.model, raw),
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
  const policy = await readDaemonPolicy();
  return {
    ...enforceDaemonPolicy(normalized, policy),
    daemonAllowed: policy.daemonAllowed,
    daemonManaged: policy.managed,
  };
}

export async function saveSettings(settings: Settings): Promise<void> {
  const {
    daemonAllowed: _daemonAllowed,
    daemonManaged: _daemonManaged,
    ...storedSettings
  } = settings as EffectiveSettings;
  const normalized = {
    ...storedSettings,
    daemonPort: normalizeDaemonPort(storedSettings.daemonPort),
    summaryRuntime: normalizeSummaryRuntime(storedSettings.summaryRuntime),
    provider: normalizeProvider(storedSettings.provider),
    providerApiKeys: normalizeProviderMap(storedSettings.providerApiKeys),
    providerBaseUrls: normalizeProviderMap(storedSettings.providerBaseUrls),
    model: normalizeModel(storedSettings.model),
    length: normalizeLength(storedSettings.length),
    language: normalizeLanguage(storedSettings.language),
    promptOverride: normalizePromptOverride(storedSettings.promptOverride),
    hoverPrompt: normalizeHoverPrompt(storedSettings.hoverPrompt),
    autoCliOrder: normalizeAutoCliOrder(storedSettings.autoCliOrder),
    requestMode: normalizeRequestMode(storedSettings.requestMode),
    slidesLayout: normalizeSlidesLayout(storedSettings.slidesLayout),
    firecrawlMode: normalizeFirecrawlMode(storedSettings.firecrawlMode),
    markdownMode: normalizeMarkdownMode(storedSettings.markdownMode),
    preprocessMode: normalizePreprocessMode(storedSettings.preprocessMode),
    youtubeMode: normalizeYoutubeMode(storedSettings.youtubeMode),
    timeout: normalizeTimeout(storedSettings.timeout),
    retries: normalizeRetries(storedSettings.retries),
    maxOutputTokens: normalizeMaxOutputTokens(storedSettings.maxOutputTokens),
    transcriber: normalizeTranscriber(storedSettings.transcriber),
    fontFamily: normalizeFontFamily(storedSettings.fontFamily),
    maxChars: normalizeMaxChars(storedSettings.maxChars),
    fontSize: normalizeFontSize(storedSettings.fontSize),
    lineHeight: normalizeLineHeight(storedSettings.lineHeight),
    colorScheme: normalizeColorScheme(storedSettings.colorScheme),
    colorMode: normalizeColorMode(storedSettings.colorMode),
  };
  await writeStoredSettings(normalized);
}

export function getProviderSettings(settings: Settings): ProviderSettings {
  return {
    provider: settings.provider,
    apiKeys: settings.providerApiKeys,
    baseUrls: settings.providerBaseUrls,
  };
}

export async function patchSettings(patch: Partial<Settings>): Promise<Settings> {
  const current = await loadSettings();
  const next = { ...current, ...patch };
  await saveSettings(next);
  return next;
}
