import type {
  SummarizeRequestBody,
  SummarizeRequestOverrides,
} from "@steipete/summarize-core/runtime";
import type { Settings } from "./settings";
import { isYouTubeWatchUrl } from "./youtube-url";

export type ExtractedPage = {
  url: string;
  title: string | null;
  text: string;
  truncated: boolean;
  mediaDurationSeconds?: number | null;
  media?: { hasVideo: boolean; hasAudio: boolean; hasCaptions: boolean } | null;
};

export function buildDaemonRequestBody({
  extracted,
  settings,
  noCache,
}: {
  extracted: ExtractedPage;
  settings: Settings;
  noCache?: boolean;
}): SummarizeRequestBody {
  const promptOverride = settings.promptOverride?.trim();
  const maxOutputTokens = settings.maxOutputTokens?.trim();
  const timeout = settings.timeout?.trim();
  const overrides: SummarizeRequestOverrides = {};
  if (settings.requestMode) overrides.mode = settings.requestMode;
  if (settings.firecrawlMode) overrides.firecrawl = settings.firecrawlMode;
  if (settings.markdownMode) overrides.markdownMode = settings.markdownMode;
  if (settings.preprocessMode) overrides.preprocess = settings.preprocessMode;
  if (settings.youtubeMode) overrides.youtube = settings.youtubeMode;
  if (settings.transcriber) overrides.transcriber = settings.transcriber;
  if (timeout) overrides.timeout = timeout;
  if (typeof settings.retries === "number" && Number.isFinite(settings.retries)) {
    overrides.retries = settings.retries;
  }
  if (maxOutputTokens) overrides.maxOutputTokens = maxOutputTokens;
  overrides.autoCliFallback = settings.autoCliFallback;
  const autoCliOrder = settings.autoCliOrder?.trim();
  if (autoCliOrder) overrides.autoCliOrder = autoCliOrder;
  const diagnostics = settings.extendedLogging ? { includeContent: true } : null;
  return {
    url: extracted.url,
    title: extracted.title,
    text: extracted.text,
    truncated: extracted.truncated,
    model: settings.model,
    length: settings.length,
    language: settings.language,
    ...(promptOverride ? { prompt: promptOverride } : {}),
    ...(noCache ? { noCache: true } : {}),
    ...(diagnostics ? { diagnostics } : {}),
    ...overrides,
    maxCharacters: settings.maxChars,
  };
}

export function buildSummarizeRequestBody({
  extracted,
  settings,
  noCache,
  inputMode,
  timestamps,
  slides,
}: {
  extracted: ExtractedPage;
  settings: Settings;
  noCache?: boolean;
  inputMode?: "page" | "video";
  timestamps?: boolean;
  slides?: {
    enabled: boolean;
    ocr?: boolean;
    maxSlides?: number | null;
    minDurationSeconds?: number | null;
  };
}): SummarizeRequestBody {
  const baseBody = buildDaemonRequestBody({ extracted, settings, noCache });
  const withTimestamps = timestamps ? { ...baseBody, timestamps: true } : baseBody;
  const slidesEnabled = Boolean(slides?.enabled);
  const slidesOcr = Boolean(slides?.ocr);
  const slidesSettings = slidesEnabled
    ? {
        slides: true,
        ...(slidesOcr ? { slidesOcr: true } : {}),
        ...(typeof slides?.maxSlides === "number" && Number.isFinite(slides.maxSlides)
          ? { slidesMax: slides.maxSlides }
          : {}),
        ...(typeof slides?.minDurationSeconds === "number" &&
        Number.isFinite(slides.minDurationSeconds)
          ? { slidesMinDuration: slides.minDurationSeconds }
          : {}),
      }
    : {};
  if (inputMode === "video") {
    const videoOverrides = isYouTubeWatchUrl(extracted.url)
      ? ({ mode: "url" } as const)
      : ({ mode: "url", videoMode: "transcript" } as const);
    return {
      ...withTimestamps,
      ...videoOverrides,
      ...slidesSettings,
    };
  }
  if (inputMode === "page") {
    return { ...withTimestamps, mode: "page" };
  }
  return slidesEnabled ? { ...withTimestamps, ...slidesSettings } : withTimestamps;
}
