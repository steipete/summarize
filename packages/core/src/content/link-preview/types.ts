export type TranscriptSource =
  | "youtubei"
  | "captionTracks"
  | "embedded"
  | "yt-dlp"
  | "youtube-media"
  | "podcastTranscript"
  | "whisper"
  | "apify"
  | "html"
  | "unavailable"
  | "unknown";

export type TranscriptSegment = {
  startMs: number;
  endMs?: number | null;
  text: string;
  speaker?: string | null;
};

export const CACHE_MODES = ["default", "bypass"] as const;
export type CacheMode = (typeof CACHE_MODES)[number];

export type CacheStatus = "hit" | "miss" | "expired" | "bypassed" | "fallback" | "unknown";

export interface TranscriptDiagnostics {
  cacheMode: CacheMode;
  cacheStatus: CacheStatus;
  textProvided: boolean;
  provider: TranscriptSource | null;
  attemptedProviders: TranscriptSource[];
  notes?: string | null;
}

export interface FirecrawlDiagnostics {
  attempted: boolean;
  used: boolean;
  cacheMode: CacheMode;
  cacheStatus: CacheStatus;
  notes?: string | null;
}

export interface MarkdownDiagnostics {
  requested: boolean;
  used: boolean;
  provider: "firecrawl" | "llm" | null;
  notes?: string | null;
}

export interface EmbeddedVideoDiagnostics {
  mode: "auto" | "off" | "prefer" | "both";
  detected: boolean;
  used: boolean;
  url: string | null;
  source: "iframe" | "open-graph" | "video-tag" | null;
  confidence: "high" | "medium" | null;
  composition: "article" | "transcript" | "both";
  notes?: string | null;
}

export interface ContentFetchDiagnostics {
  strategy: "bird" | "xurl" | "twitter-syndication" | "nitter" | "firecrawl" | "html";
  firecrawl: FirecrawlDiagnostics;
  markdown: MarkdownDiagnostics;
  transcript: TranscriptDiagnostics;
  embeddedVideo?: EmbeddedVideoDiagnostics;
}

export interface TranscriptResolution {
  text: string | null;
  source: TranscriptSource | null;
  metadata?: Record<string, unknown> | null;
  diagnostics?: TranscriptDiagnostics;
  segments?: TranscriptSegment[] | null;
}
