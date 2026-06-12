export type SummarizeRequestMode = "auto" | "url" | "page";

export type SummarizeRequestOverrides = {
  mode?: SummarizeRequestMode;
  firecrawl?: "off" | "auto" | "always";
  markdownMode?: "off" | "auto" | "llm" | "readability";
  preprocess?: "off" | "auto" | "always";
  youtube?: "auto" | "web" | "apify" | "yt-dlp" | "no-auto";
  videoMode?: "auto" | "transcript" | "understand";
  embeddedVideo?: "auto" | "off" | "prefer" | "both";
  timestamps?: boolean;
  diarize?: string | boolean;
  forceSummary?: boolean;
  timeout?: string | number;
  retries?: string | number;
  maxOutputTokens?: string | number;
  transcriber?: "auto" | "whisper" | "parakeet" | "canary";
  autoCliFallback?: boolean;
  autoCliOrder?: string;
  magicCliAuto?: boolean;
  magicCliOrder?: string;
};

export type SummarizeRequestBody = SummarizeRequestOverrides & {
  url: string;
  title: string | null;
  text: string;
  truncated: boolean;
  model: string;
  length: string;
  language: string;
  prompt?: string;
  noCache?: boolean;
  extractOnly?: boolean;
  diagnostics?: { includeContent: boolean };
  maxCharacters: number | null;
  maxExtractCharacters?: number;
  format?: "text" | "markdown" | "md";
  slides?: boolean;
  slidesOcr?: boolean;
  slidesSceneThreshold?: number;
  slidesMax?: number;
  slidesMinDuration?: number;
};
