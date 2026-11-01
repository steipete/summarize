import type { SlidesPayload } from "./panel-utils";

export type CachedExtract = {
  url: string;
  title: string | null;
  text: string;
  source: "page" | "url";
  truncated: boolean;
  totalCharacters: number;
  wordCount: number | null;
  media: { hasVideo: boolean; hasAudio: boolean; hasCaptions: boolean } | null;
  transcriptSource: string | null;
  transcriptionProvider: string | null;
  transcriptCharacters: number | null;
  transcriptWordCount: number | null;
  transcriptLines: number | null;
  transcriptTimedText: string | null;
  mediaDurationSeconds: number | null;
  slides: SlidesPayload | null;
  diagnostics?: {
    strategy: string;
    markdown?: { used?: boolean; provider?: string | null } | null;
    firecrawl?: { used?: boolean } | null;
    transcript?: {
      provider?: string | null;
      cacheStatus?: string | null;
      attemptedProviders?: string[] | null;
    } | null;
  } | null;
};

export type MediaHint = {
  url: string;
  media: NonNullable<CachedExtract["media"]>;
  mediaDurationSeconds: number | null;
  wordCount: number;
};

export type MediaHintStore = {
  getMediaHint(tabId: number, url?: string | null): MediaHint | null;
  setMediaHint(tabId: number, hint: MediaHint): void;
};

function countWords(text: string): number {
  return text.length > 0 ? text.split(/\s+/).filter(Boolean).length : 0;
}

export function createCachedExtract({
  extracted,
  source = "page",
  diagnostics = null,
  title,
  transcript = null,
  slides = null,
  wordCount,
}: {
  extracted: {
    url: string;
    title?: string | null;
    text: string;
    truncated: boolean;
    media?: { hasVideo: boolean; hasAudio: boolean; hasCaptions: boolean } | null;
    mediaDurationSeconds?: number | null;
  };
  source?: CachedExtract["source"];
  diagnostics?: CachedExtract["diagnostics"];
  title: string | null;
  transcript?: {
    timedText: string;
    text?: string | null;
    source?: string | null;
    provider?: string | null;
  } | null;
  slides?: SlidesPayload | null;
  wordCount?: number | null;
}): CachedExtract {
  const transcriptText = transcript?.text ?? null;
  return {
    url: extracted.url,
    title: extracted.title ?? title,
    text: extracted.text,
    source,
    truncated: extracted.truncated,
    totalCharacters: extracted.text.length,
    wordCount: wordCount === undefined ? countWords(extracted.text) : wordCount,
    media: extracted.media ?? null,
    transcriptSource: transcript?.source ?? null,
    transcriptionProvider: transcript?.provider ?? null,
    transcriptCharacters: transcriptText?.length ?? null,
    transcriptWordCount: transcriptText === null ? null : countWords(transcriptText),
    transcriptLines:
      transcript === null ? null : transcript.timedText.split(/\r?\n/).filter(Boolean).length,
    transcriptTimedText: transcript?.timedText ?? null,
    mediaDurationSeconds: extracted.mediaDurationSeconds ?? null,
    slides,
    diagnostics,
  };
}
