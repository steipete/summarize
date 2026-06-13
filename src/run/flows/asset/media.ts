/**
 * Media file transcription handler for local audio/video files.
 * Phase 2: Transcript provider integration
 * Phase 2.2: Local file path handling for transcript caching
 */

import { statSync } from "node:fs";
import { isAbsolute, resolve as resolvePath } from "node:path";
import { pathToFileURL } from "node:url";
import {
  createLinkPreviewClient,
  resolveTranscriptionAvailability,
  type ExtractedLinkContent,
} from "../../../content/index.js";
import { createFirecrawlScraper } from "../../../firecrawl.js";
import {
  identifySpeakersInExtractedContent,
  rememberSpeakerMappings,
  SpeakerIdentificationError,
} from "../../../speaker-identification/index.js";
import type { AssetAttachment } from "../../attachments.js";
import { readTweetWithPreferredClient } from "../../bird.js";
import { resolveTwitterCookies } from "../../cookies/twitter.js";
import { hasBirdCli, hasXurlCli } from "../../env.js";
import { writeVerbose } from "../../logging.js";
import { MAX_LOCAL_MEDIA_BYTES, MAX_LOCAL_MEDIA_LABEL } from "./media-policy.js";
import { executeAssetSummary, presentAssetSummary } from "./summary.js";
import type {
  AssetSummaryContext,
  AssetSummaryResult,
  PresentAssetSummaryArgs,
  SummarizeAssetArgs,
} from "./types.js";

export type MediaFileExecutionResult =
  | {
      kind: "extraction";
      extracted: ExtractedLinkContent;
    }
  | {
      kind: "summary";
      extracted: ExtractedLinkContent;
      summaryArgs: PresentAssetSummaryArgs;
      summary: AssetSummaryResult;
    };

/**
 * Get file modification time for cache invalidation support.
 * Returns null if the path is not a local file or file doesn't exist.
 */
function getFileModificationTime(filePath: string): number | null {
  // Only support absolute local file paths
  if (!isAbsolute(filePath)) {
    return null;
  }
  try {
    const stats = statSync(filePath);
    return stats.mtimeMs ?? null;
  } catch {
    // File doesn't exist or can't be accessed
    return null;
  }
}

/**
 * Handler for local audio/video files.
 *
 * Phase 2 Implementation:
 * 1. Validates transcription provider availability
 * 2. Creates LinkPreviewClient with necessary dependencies
 * 3. Calls client.fetchLinkContent to trigger transcription
 * 4. Converts transcript text to AssetAttachment
 * 5. Calls summarizeAsset with the transcript
 *
 * Phase 2.2 Enhancement:
 * - Captures file modification time for cache invalidation
 * - Passes fileMtime to transcript cache for local file support
 */
export async function executeMediaFile(
  ctx: AssetSummaryContext,
  args: SummarizeAssetArgs,
): Promise<MediaFileExecutionResult> {
  // Check if basic transcription setup is available
  const groqKey = ctx.env.GROQ_API_KEY ?? ctx.apiStatus.groqApiKey;
  const geminiKey =
    ctx.env.GEMINI_API_KEY ??
    ctx.env.GOOGLE_GENERATIVE_AI_API_KEY ??
    ctx.env.GOOGLE_API_KEY ??
    ctx.apiStatus.googleApiKey;
  const openaiKey = ctx.env.OPENAI_API_KEY ?? ctx.apiStatus.openaiApiKey;
  const falKey = ctx.env.FAL_KEY ?? ctx.apiStatus.falApiKey;
  const assemblyaiKey = ctx.env.ASSEMBLYAI_API_KEY ?? ctx.apiStatus.assemblyaiApiKey;
  const elevenlabsKey = ctx.env.ELEVENLABS_API_KEY ?? ctx.apiStatus.elevenlabsApiKey;

  // Helper to check if a binary is available on PATH
  const isBinaryAvailable = async (binary: string): Promise<boolean> => {
    const { spawn } = await import("node:child_process");
    return new Promise<boolean>((resolve) => {
      const proc = spawn(binary, ["--help"], {
        stdio: ["ignore", "ignore", "ignore"],
        env: ctx.env,
      });
      proc.on("error", () => resolve(false));
      proc.on("close", (code) => resolve(code === 0));
    });
  };

  // Check for yt-dlp: either via env var or on PATH
  const ytDlpPath = ctx.env.YT_DLP_PATH || ((await isBinaryAvailable("yt-dlp")) ? "yt-dlp" : null);

  if (ctx.transcriptDiarization === "elevenlabs" && !elevenlabsKey) {
    throw new Error("Speaker diarization with ElevenLabs requires ELEVENLABS_API_KEY");
  }
  if (ctx.transcriptDiarization === "openai" && !openaiKey) {
    throw new Error("Speaker diarization with OpenAI requires OPENAI_API_KEY");
  }
  if (ctx.transcriptDiarization === "auto" && !elevenlabsKey && !openaiKey) {
    throw new Error("Speaker diarization requires ELEVENLABS_API_KEY or OPENAI_API_KEY");
  }

  const transcription = {
    env: ctx.envForRun,
    falApiKey: falKey,
    groqApiKey: groqKey,
    assemblyaiApiKey: assemblyaiKey ?? ctx.apiStatus.assemblyaiApiKey,
    elevenlabsApiKey: elevenlabsKey,
    geminiApiKey: geminiKey,
    openaiApiKey: openaiKey,
  };
  const availability = await resolveTranscriptionAvailability({ transcription });
  const hasAnyTranscriptionProvider =
    ctx.transcriptDiarization !== null || availability.hasAnyProvider;

  if (!hasAnyTranscriptionProvider) {
    throw new Error(`Media file transcription requires one of the following:

1. Local ONNX (Parakeet or Canary):
   Run summarize transcriber setup

2. Groq Whisper (fast, free tier):
   Set GROQ_API_KEY=gsk_...

3. Gemini audio transcription:
   Set GEMINI_API_KEY=...

4. AssemblyAI transcription:
   Set ASSEMBLYAI_API_KEY=...

5. OpenAI Whisper:
   Set OPENAI_API_KEY=sk-...

6. FAL Whisper:
   Set FAL_KEY=...

7. Local whisper.cpp:
   brew install whisper-cpp
   Ensure whisper-cli is on your PATH (or set SUMMARIZE_WHISPER_CPP_BINARY)

See: summarize transcriber help`);
  }

  const isHttpUrl = (value: string): boolean => {
    try {
      const parsed = new URL(value);
      return parsed.protocol === "http:" || parsed.protocol === "https:";
    } catch {
      return false;
    }
  };

  // For URLs, skip local file validation - yt-dlp will handle the download
  const isUrl = args.sourceKind === "asset-url" || isHttpUrl(args.sourceLabel);

  let absolutePath: string;
  let fileMtime: number | null = null;

  if (isUrl) {
    // For URLs, use the URL directly - no local path resolution needed
    absolutePath = args.sourceLabel;
  } else {
    absolutePath = resolvePath(args.sourceLabel);

    // Get file modification time for cache invalidation (after path resolution)
    fileMtime = getFileModificationTime(absolutePath);

    // Validate file size before attempting transcription
    try {
      const stats = statSync(absolutePath);
      const fileSizeBytes = stats.size;
      const maxSizeBytes = MAX_LOCAL_MEDIA_BYTES;

      if (fileSizeBytes === 0) {
        throw new Error("Media file is empty (0 bytes). Please provide a valid audio/video file.");
      }

      if (fileSizeBytes > maxSizeBytes) {
        const fileSizeMB = Math.round(fileSizeBytes / (1024 * 1024));
        throw new Error(
          `Media file is too large (${fileSizeMB} MB). Maximum supported size is ${MAX_LOCAL_MEDIA_LABEL}.`,
        );
      }
    } catch (error) {
      if (
        error instanceof Error &&
        (error.message.includes("empty") || error.message.includes("large"))
      ) {
        throw error; // Re-throw our validation errors
      }
      // For other statSync errors (e.g., file not found), let them bubble up
      throw new Error(
        `Unable to access media file: ${error instanceof Error ? error.message : "Unknown error"}`,
      );
    }
  }

  const cacheMode = ctx.cache.mode;

  // Create Firecrawl scraper if configured
  const firecrawlScraper =
    ctx.apiStatus.firecrawlConfigured && ctx.env.FIRECRAWL_API_KEY
      ? createFirecrawlScraper({
          apiKey: ctx.env.FIRECRAWL_API_KEY,
          fetchImpl: ctx.trackedFetch,
        })
      : null;

  // Create reader for X tweets (for completeness, not used for media)
  const readTweetWithBirdClient =
    hasXurlCli(ctx.env) || hasBirdCli(ctx.env)
      ? ({ url, timeoutMs }: { url: string; timeoutMs: number }) =>
          readTweetWithPreferredClient({ url, timeoutMs, env: ctx.env })
      : null;

  // Create link preview client for transcript resolution
  const transcriptCache =
    cacheMode === "default" ? (ctx.cache.store?.transcriptCache ?? null) : null;

  const client = createLinkPreviewClient({
    env: ctx.envForRun,
    apifyApiToken: ctx.apiStatus.apifyToken,
    ytDlpPath: ytDlpPath,
    transcription,
    scrapeWithFirecrawl: firecrawlScraper,
    convertHtmlToMarkdown: null, // Not needed for media
    readTweetWithBird: readTweetWithBirdClient,
    resolveTwitterCookies: async (_args) => {
      const res = await resolveTwitterCookies({ env: ctx.env });
      return {
        cookiesFromBrowser: res.cookies.cookiesFromBrowser,
        source: res.cookies.source,
        warnings: res.warnings,
      };
    },
    fetch: ctx.trackedFetch,
    transcriptCache,
    mediaCache: ctx.mediaCache ?? null,
    onProgress: (_event) => {
      // Could update progress here if needed
      // For now, silent transcription
    },
  });

  try {
    // For URLs, use directly. For local files, convert to file:// URL.
    // yt-dlp can handle both http(s) URLs and file:// URLs.
    const fileUrl = isUrl ? absolutePath : pathToFileURL(absolutePath).href;

    // Fetch the link content (will trigger transcription for media)
    // Using file:// URL ensures the provider chain can handle local files properly
    let extracted: ExtractedLinkContent = await client.fetchLinkContent(fileUrl, {
      timeoutMs: ctx.timeoutMs,
      cacheMode,
      youtubeTranscript: "auto", // Not used for local files, but set for completeness
      mediaTranscript: "prefer", // Prefer transcription for media files
      transcriptTimestamps: ctx.transcriptTimestamps,
      transcriptDiarization: ctx.transcriptDiarization,
      fileMtime, // Include file modification time for cache invalidation
    });

    if (ctx.speakerIdentification) {
      const identified = await identifySpeakersInExtractedContent({
        extracted,
        sourceUrl: args.sourceLabel,
        settings: ctx.speakerIdentification,
        openaiApiKey: openaiKey,
        openaiBaseUrl: ctx.apiStatus.providerBaseUrls.openai,
        timeoutMs: ctx.timeoutMs,
        maxContentCharacters: null,
        fetchImpl: ctx.trackedFetch,
      });
      extracted = identified.extracted;
      if (identified.usage) {
        ctx.llmCalls.push({
          provider: "openai",
          model: ctx.speakerIdentification.model,
          usage: identified.usage,
          purpose: "speaker-identification",
        });
      }
      if (identified.warning) {
        writeVerbose(ctx.stderr, ctx.verbose, identified.warning, ctx.verboseColor, ctx.envForRun);
        ctx.stderr.write(`Warning: ${identified.warning}\n`);
      }
      if (ctx.speakerIdentification.remember) {
        if (!ctx.configPath || !identified.transcriptHash) {
          throw new SpeakerIdentificationError(
            "Unable to resolve the config path or transcript hash for --remember-speakers.",
          );
        }
        try {
          await rememberSpeakerMappings({
            configPath: ctx.configPath,
            settings: ctx.speakerIdentification,
            mappings: identified.mappings,
            transcriptHash: identified.transcriptHash,
          });
        } catch (error) {
          throw new SpeakerIdentificationError(
            `Failed to remember speaker mappings: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    }

    // Check if we got a transcript
    if (!extracted.content || extracted.content.trim().length === 0) {
      throw new Error(`Failed to transcribe media file. Check that:
  - Audio/video format is supported (MP3, WAV, M4A, OGG, FLAC, MP4, MOV, WEBM)
  - Transcription provider is configured
  - File is readable
  - Media file is not corrupted`);
    }

    // Create a text-based attachment from the transcript
    const filename = args.sourceLabel.split("/").pop() ?? "media";
    const transcriptAttachment: AssetAttachment = {
      mediaType: "text/plain",
      filename: `${filename}.transcript.txt`,
      kind: "file",
      bytes: new TextEncoder().encode(extracted.content),
    };

    writeVerbose(
      ctx.stderr,
      ctx.verbose,
      `transcription done media file: ${extracted.diagnostics?.transcript?.provider ?? "unknown"}`,
      false,
      ctx.envForRun,
    );

    if (ctx.extractMode) {
      return { kind: "extraction", extracted };
    }

    const summaryExecutionArgs: SummarizeAssetArgs = {
      sourceKind: "file",
      sourceLabel: `${args.sourceLabel} (transcript)`,
      attachment: transcriptAttachment,
      onModelChosen: args.onModelChosen,
    };
    const summary = await executeAssetSummary(ctx, summaryExecutionArgs);
    const summaryArgs: PresentAssetSummaryArgs = {
      sourceKind: summaryExecutionArgs.sourceKind,
      sourceLabel: summaryExecutionArgs.sourceLabel,
      attachment: {
        kind: summaryExecutionArgs.attachment.kind,
        mediaType: summaryExecutionArgs.attachment.mediaType,
        filename: summaryExecutionArgs.attachment.filename,
      },
    };
    return { kind: "summary", extracted, summaryArgs, summary };
  } catch (error) {
    if (error instanceof SpeakerIdentificationError) {
      throw error;
    }
    // Re-throw with better context for transcription errors
    if (error instanceof Error && error.message.includes("transcribe")) {
      throw error;
    }
    throw new Error(
      `Transcription failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export async function presentMediaFileResult(
  ctx: AssetSummaryContext,
  result: MediaFileExecutionResult,
): Promise<void> {
  if (result.kind === "summary") {
    await presentAssetSummary(ctx, result.summaryArgs, result.summary);
    return;
  }
  ctx.clearProgressForStdout();
  ctx.stdout.write(result.extracted.content);
  if (!result.extracted.content.endsWith("\n")) {
    ctx.stdout.write("\n");
  }
}
