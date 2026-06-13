import { resolveTranscriptForLink } from "../../transcript/index.js";
import { resolveTranscriptionAvailability } from "../../transcript/providers/transcription-start.js";
import type { resolveTranscriptionConfig } from "../../transcript/transcription-config.js";
import { isDirectMediaUrl } from "../../url.js";
import type { LinkPreviewDeps } from "../deps.js";
import type { CacheMode } from "../types.js";
import { extractApplePodcastIds, extractSpotifyEpisodeId } from "./podcast-utils.js";
import { isTwitterBroadcastUrl } from "./twitter-utils.js";
import type { ExtractedLinkContent, MediaTranscriptMode, YoutubeTranscriptMode } from "./types.js";
import {
  appendNote,
  ensureTranscriptDiagnostics,
  finalizeExtractedLinkContent,
  selectBaseContent,
} from "./utils.js";

type TranscriptOnlyStrategy = {
  matches: (url: string, mediaTranscriptMode: MediaTranscriptMode) => boolean;
  requiresTranscriptionProvider: boolean;
  availabilityError: string | null;
  transcriptMode: (mode: MediaTranscriptMode) => MediaTranscriptMode;
  failureLabel: string;
  transcriptNote: string;
  firecrawlNote: string;
  markdownNote: string;
  siteName: string | null;
  video: (url: string) => { kind: "direct"; url: string } | null;
  isVideoOnly: boolean;
};

const TRANSCRIPT_ONLY_STRATEGIES: readonly TranscriptOnlyStrategy[] = [
  {
    matches: (url) => Boolean(extractSpotifyEpisodeId(url)),
    requiresTranscriptionProvider: true,
    availabilityError:
      "Spotify episode transcription requires a transcription provider (install whisper-cpp or set GROQ_API_KEY, ASSEMBLYAI_API_KEY, GEMINI_API_KEY, OPENAI_API_KEY, or FAL_KEY); otherwise you may only get a captcha/recaptcha HTML page.",
    transcriptMode: (mode) => mode,
    failureLabel: "Spotify episode",
    transcriptNote: "Spotify episode: skipped HTML fetch to avoid captcha pages",
    firecrawlNote: "Spotify short-circuit skipped HTML/Firecrawl",
    markdownNote: "Spotify short-circuit uses transcript content",
    siteName: "Spotify",
    video: () => null,
    isVideoOnly: false,
  },
  {
    matches: (url) => Boolean(extractApplePodcastIds(url)),
    requiresTranscriptionProvider: true,
    availabilityError:
      "Apple Podcasts transcription requires a transcription provider (install whisper-cpp or set GROQ_API_KEY, ASSEMBLYAI_API_KEY, GEMINI_API_KEY, OPENAI_API_KEY, or FAL_KEY); otherwise you may only get a slow/blocked HTML page.",
    transcriptMode: (mode) => mode,
    failureLabel: "Apple Podcasts episode",
    transcriptNote: "Apple Podcasts: skipped HTML fetch (prefer iTunes lookup / enclosures)",
    firecrawlNote: "Apple Podcasts short-circuit skipped HTML/Firecrawl",
    markdownNote: "Apple Podcasts short-circuit uses transcript content",
    siteName: "Apple Podcasts",
    video: () => null,
    isVideoOnly: false,
  },
  {
    matches: (url) => isTwitterBroadcastUrl(url),
    requiresTranscriptionProvider: false,
    availabilityError: null,
    transcriptMode: (mode) => (mode === "auto" ? "prefer" : mode),
    failureLabel: "X broadcast",
    transcriptNote: "X broadcast: skipped HTML/Firecrawl",
    firecrawlNote: "X broadcast short-circuit skipped HTML/Firecrawl",
    markdownNote: "X broadcast uses transcript content",
    siteName: "X",
    video: (url) => ({ kind: "direct", url }),
    isVideoOnly: true,
  },
  {
    matches: (url, mode) => isDirectMediaUrl(url) && mode === "prefer",
    requiresTranscriptionProvider: false,
    availabilityError: null,
    transcriptMode: (mode) => mode,
    failureLabel: "media",
    transcriptNote: "Direct media URL: skipped HTML/Firecrawl",
    firecrawlNote: "Direct media URL skipped HTML/Firecrawl",
    markdownNote: "Direct media URL uses transcript content",
    siteName: null,
    video: (url) => ({ kind: "direct", url }),
    isVideoOnly: true,
  },
];

export async function tryTranscriptOnlyStrategy({
  url,
  deps,
  transcription,
  maxCharacters,
  youtubeTranscriptMode,
  mediaTranscriptMode,
  transcriptTimestamps,
  transcriptDiarization,
  transcriptVideoDownload,
  cacheMode,
  fileMtime,
  markdownRequested,
}: {
  url: string;
  deps: LinkPreviewDeps;
  transcription: ReturnType<typeof resolveTranscriptionConfig>;
  maxCharacters: number | null;
  youtubeTranscriptMode: YoutubeTranscriptMode;
  mediaTranscriptMode: MediaTranscriptMode;
  transcriptTimestamps: boolean;
  transcriptDiarization: NonNullable<
    Parameters<typeof resolveTranscriptForLink>[3]
  >["transcriptDiarization"];
  transcriptVideoDownload: boolean;
  cacheMode: CacheMode;
  fileMtime: number | null;
  markdownRequested: boolean;
}): Promise<ExtractedLinkContent | null> {
  const strategy = TRANSCRIPT_ONLY_STRATEGIES.find((candidate) =>
    candidate.matches(url, mediaTranscriptMode),
  );
  if (!strategy) return null;

  const transcriptResolution = await resolveTranscriptForLink(url, null, deps, {
    youtubeTranscriptMode,
    mediaTranscriptMode: strategy.transcriptMode(mediaTranscriptMode),
    transcriptTimestamps,
    transcriptDiarization,
    transcriptVideoDownload,
    cacheMode,
    fileMtime,
  });
  if (!transcriptResolution.text) {
    if (strategy.requiresTranscriptionProvider) {
      const availability = await resolveTranscriptionAvailability({ transcription });
      if (!availability.hasAnyProvider) {
        throw new Error(strategy.availabilityError ?? "Transcription provider unavailable");
      }
    }
    const notes = transcriptResolution.diagnostics?.notes;
    throw new Error(`Failed to transcribe ${strategy.failureLabel}${notes ? ` (${notes})` : ""}`);
  }

  const transcriptDiagnostics = ensureTranscriptDiagnostics(transcriptResolution, cacheMode);
  transcriptDiagnostics.notes = appendNote(transcriptDiagnostics.notes, strategy.transcriptNote);

  return finalizeExtractedLinkContent({
    url,
    baseContent: selectBaseContent("", transcriptResolution.text, transcriptResolution.segments),
    maxCharacters,
    title: null,
    description: null,
    siteName: strategy.siteName,
    transcriptResolution,
    video: strategy.video(url),
    isVideoOnly: strategy.isVideoOnly,
    diagnostics: {
      strategy: "html",
      firecrawl: {
        attempted: false,
        used: false,
        cacheMode,
        cacheStatus: cacheMode === "bypass" ? "bypassed" : "unknown",
        notes: strategy.firecrawlNote,
      },
      markdown: {
        requested: markdownRequested,
        used: false,
        provider: null,
        notes: strategy.markdownNote,
      },
      transcript: transcriptDiagnostics,
    },
  });
}
