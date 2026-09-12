import { DEFAULT_DAEMON_PORT, defaultSettings } from "./settings-defaults";
import type {
  Settings,
  DirectProvider,
  SlidesLayout,
  SlideRuntime,
  SummaryRuntime,
} from "./settings-types";
import { normalizeColorMode, normalizeColorScheme } from "./theme";

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

function normalizeChoice<Value extends string>(
  value: unknown,
  choices: readonly Value[],
  fallback: Value,
): Value {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  return choices.find((choice) => choice === normalized) ?? fallback;
}

type ChoiceSettings = Pick<
  Settings,
  | "requestMode"
  | "firecrawlMode"
  | "markdownMode"
  | "preprocessMode"
  | "youtubeMode"
  | "transcriber"
>;

export function normalizeSettingChoices(
  settings: Record<keyof ChoiceSettings, unknown>,
): ChoiceSettings {
  return {
    requestMode: normalizeChoice(
      settings.requestMode,
      ["page", "url"],
      defaultSettings.requestMode,
    ),
    firecrawlMode: normalizeChoice(
      settings.firecrawlMode,
      ["off", "auto", "always"],
      defaultSettings.firecrawlMode,
    ),
    markdownMode: normalizeChoice(
      settings.markdownMode,
      ["off", "auto", "llm", "readability"],
      defaultSettings.markdownMode,
    ),
    preprocessMode: normalizeChoice(
      settings.preprocessMode,
      ["off", "auto", "always"],
      defaultSettings.preprocessMode,
    ),
    youtubeMode: normalizeChoice(
      settings.youtubeMode,
      ["auto", "web", "apify", "yt-dlp", "no-auto"],
      defaultSettings.youtubeMode,
    ),
    transcriber: normalizeChoice(
      settings.transcriber,
      ["whisper", "parakeet", "canary"],
      defaultSettings.transcriber,
    ),
  };
}

export function normalizeSettings(settings: Settings): Settings {
  return {
    ...settings,
    ...normalizeSettingChoices(settings),
    daemonPort: normalizeDaemonPort(settings.daemonPort),
    summaryRuntime: normalizeSummaryRuntime(settings.summaryRuntime),
    provider: normalizeProvider(settings.provider),
    providerApiKeys: normalizeProviderMap(settings.providerApiKeys),
    providerBaseUrls: normalizeProviderMap(settings.providerBaseUrls),
    model: normalizeModel(settings.model),
    length: normalizeLength(settings.length),
    language: normalizeLanguage(settings.language),
    promptOverride: normalizePromptOverride(settings.promptOverride),
    hoverPrompt: normalizeHoverPrompt(settings.hoverPrompt),
    autoCliOrder: normalizeAutoCliOrder(settings.autoCliOrder),
    slidesLayout: normalizeSlidesLayout(settings.slidesLayout),
    timeout: normalizeTimeout(settings.timeout),
    retries: normalizeRetries(settings.retries),
    maxOutputTokens: normalizeMaxOutputTokens(settings.maxOutputTokens),
    fontFamily: normalizeFontFamily(settings.fontFamily),
    maxChars: normalizeMaxChars(settings.maxChars),
    fontSize: normalizeFontSize(settings.fontSize),
    lineHeight: normalizeLineHeight(settings.lineHeight),
    colorScheme: normalizeColorScheme(settings.colorScheme),
    colorMode: normalizeColorMode(settings.colorMode),
  };
}

export function normalizeStoredSettings(
  raw: Partial<Settings> & Record<string, unknown>,
): Settings {
  return normalizeSettings({
    ...defaultSettings,
    ...raw,
    token: typeof raw.token === "string" ? raw.token : defaultSettings.token,
    summaryRuntime: normalizeSummaryRuntime(raw.summaryRuntime, raw),
    daemonHintDismissed:
      typeof raw.daemonHintDismissed === "boolean"
        ? raw.daemonHintDismissed
        : defaultSettings.daemonHintDismissed,
    model: normalizeModel(raw.model, raw),
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
  });
}
