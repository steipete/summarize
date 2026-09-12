import type { SummarizeRequestOverrides } from "@steipete/summarize-core/runtime";
import type { ColorMode, ColorScheme } from "./theme";

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
