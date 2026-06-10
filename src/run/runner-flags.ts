import {
  type FirecrawlMode,
  type DiarizationMode,
  type LengthArg,
  type MarkdownMode,
  type PreprocessMode,
  parseExtractFormat,
  parseDiarizationMode,
  parseMaxExtractCharactersArg,
  parseMetricsMode,
  parseStreamMode,
  type YoutubeMode,
} from "../flags.js";
import { resolveCliRunSettings } from "./run-settings.js";

type Transcriber = "auto" | "whisper" | "parakeet" | "canary";

export type RunnerFlagResolution = {
  videoModeExplicitlySet: boolean;
  lengthExplicitlySet: boolean;
  languageExplicitlySet: boolean;
  noCacheFlag: boolean;
  noMediaCacheFlag: boolean;
  extractMode: boolean;
  json: boolean;
  forceSummary: boolean;
  slidesDebug: boolean;
  streamMode: ReturnType<typeof parseStreamMode>;
  plain: boolean;
  debug: boolean;
  verbose: boolean;
  transcriber: Transcriber;
  diarizationMode: DiarizationMode | null;
  maxExtractCharacters: ReturnType<typeof parseMaxExtractCharactersArg>;
  isYoutubeUrl: boolean;
  format: ReturnType<typeof parseExtractFormat>;
  youtubeMode: YoutubeMode;
  lengthArg: LengthArg;
  maxOutputTokensArg: number | null;
  timeoutMs: number;
  retries: number;
  preprocessMode: PreprocessMode;
  requestedFirecrawlMode: FirecrawlMode;
  markdownMode: MarkdownMode;
  metricsMode: ReturnType<typeof parseMetricsMode>;
  metricsEnabled: boolean;
  metricsDetailed: boolean;
  shouldComputeReport: boolean;
  markdownModeExplicitlySet: boolean;
};

const hasFlag = (normalizedArgv: readonly string[], ...names: readonly string[]) =>
  normalizedArgv.some((arg) => names.some((name) => arg === name || arg.startsWith(`${name}=`)));

const normalizeTranscriber = (value: unknown): Transcriber | null => {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  if (
    normalized === "auto" ||
    normalized === "whisper" ||
    normalized === "parakeet" ||
    normalized === "canary"
  ) {
    return normalized;
  }
  return null;
};

export function resolveRunnerFlags({
  normalizedArgv,
  programOpts,
  envForRun,
  url,
}: {
  normalizedArgv: readonly string[];
  programOpts: Record<string, unknown>;
  envForRun: Record<string, string | undefined>;
  url: string | null;
}): RunnerFlagResolution {
  const videoModeExplicitlySet = hasFlag(normalizedArgv, "--video-mode");
  const lengthExplicitlySet = hasFlag(normalizedArgv, "--length");
  const languageExplicitlySet = hasFlag(normalizedArgv, "--language", "--lang");
  const noCacheFlag = programOpts.cache === false;
  const noMediaCacheFlag = programOpts.mediaCache === false;
  const extractMode = Boolean(programOpts.extract) || Boolean(programOpts.extractOnly);
  const json = Boolean(programOpts.json);
  const forceSummary = Boolean(programOpts.forceSummary);
  const slidesDebug = Boolean(programOpts.slidesDebug);
  const streamMode = parseStreamMode(String(programOpts.stream));
  const plain = Boolean(programOpts.plain);
  const debug = Boolean(programOpts.debug);
  const verbose = Boolean(programOpts.verbose) || debug;

  const transcriberExplicitlySet = hasFlag(normalizedArgv, "--transcriber");
  const envTranscriber =
    envForRun.SUMMARIZE_TRANSCRIBER ?? process.env.SUMMARIZE_TRANSCRIBER ?? null;
  const transcriber =
    normalizeTranscriber(transcriberExplicitlySet ? programOpts.transcriber : envTranscriber) ??
    "auto";
  envForRun.SUMMARIZE_TRANSCRIBER = transcriber;
  const diarizationExplicitlySet = hasFlag(normalizedArgv, "--diarize");
  const diarizationMode = diarizationExplicitlySet
    ? parseDiarizationMode(typeof programOpts.diarize === "string" ? programOpts.diarize : "auto")
    : null;

  const maxExtractCharacters = parseMaxExtractCharactersArg(
    typeof programOpts.maxExtractCharacters === "string"
      ? programOpts.maxExtractCharacters
      : programOpts.maxExtractCharacters != null
        ? String(programOpts.maxExtractCharacters)
        : undefined,
  );

  const isYoutubeUrl = typeof url === "string" ? /youtube\.com|youtu\.be/i.test(url) : false;
  const formatExplicitlySet = hasFlag(normalizedArgv, "--format");
  const rawFormatOpt = typeof programOpts.format === "string" ? programOpts.format : null;
  const format = parseExtractFormat(
    formatExplicitlySet ? (rawFormatOpt ?? "text") : extractMode && !isYoutubeUrl ? "md" : "text",
  );

  const runSettings = resolveCliRunSettings({
    length: String(programOpts.length),
    firecrawl: String(programOpts.firecrawl),
    markdownMode:
      typeof programOpts.markdownMode === "string" ? programOpts.markdownMode : undefined,
    markdown: typeof programOpts.markdown === "string" ? programOpts.markdown : undefined,
    format,
    preprocess: String(programOpts.preprocess),
    youtube: String(programOpts.youtube),
    timeout: String(programOpts.timeout),
    retries: String(programOpts.retries),
    maxOutputTokens:
      typeof programOpts.maxOutputTokens === "string"
        ? programOpts.maxOutputTokens
        : programOpts.maxOutputTokens != null
          ? String(programOpts.maxOutputTokens)
          : undefined,
  });

  const metricsExplicitlySet = hasFlag(normalizedArgv, "--metrics");
  const metricsMode = parseMetricsMode(
    debug && !metricsExplicitlySet ? "detailed" : String(programOpts.metrics),
  );
  const metricsEnabled = metricsMode !== "off";
  const metricsDetailed = metricsMode === "detailed";

  return {
    videoModeExplicitlySet,
    lengthExplicitlySet,
    languageExplicitlySet,
    noCacheFlag,
    noMediaCacheFlag,
    extractMode,
    json,
    forceSummary,
    slidesDebug,
    streamMode,
    plain,
    debug,
    verbose,
    transcriber,
    diarizationMode,
    maxExtractCharacters,
    isYoutubeUrl,
    format,
    youtubeMode: runSettings.youtubeMode,
    lengthArg: runSettings.lengthArg,
    maxOutputTokensArg: runSettings.maxOutputTokensArg,
    timeoutMs: runSettings.timeoutMs,
    retries: runSettings.retries,
    preprocessMode: runSettings.preprocessMode,
    requestedFirecrawlMode: runSettings.firecrawlMode,
    markdownMode: runSettings.markdownMode,
    metricsMode,
    metricsEnabled,
    metricsDetailed,
    shouldComputeReport: metricsEnabled,
    markdownModeExplicitlySet: hasFlag(normalizedArgv, "--markdown-mode", "--markdown"),
  };
}
