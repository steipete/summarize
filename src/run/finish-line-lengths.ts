import { isYouTubeUrl } from "@steipete/summarize-core/content/url";
import { cliMessage } from "../locale.js";
import type { FinishPart } from "./finish-line-types.js";

export type ExtractedForLengths = {
  url: string;
  siteName: string | null;
  totalCharacters: number;
  wordCount: number;
  transcriptCharacters: number | null;
  transcriptLines: number | null;
  transcriptWordCount: number | null;
  transcriptSource: string | null;
  transcriptionProvider: string | null;
  mediaDurationSeconds: number | null;
  video: { kind: "youtube" | "direct"; url: string } | null;
  isVideoOnly: boolean;
  diagnostics: { transcript: { cacheStatus: string } };
};

function inferMediaKindLabelForFinishLine(
  extracted: ExtractedForLengths,
): "audio" | "video" | null {
  if (extracted.siteName === "YouTube" || isYouTubeUrl(extracted.url)) {
    return "video";
  }
  if (extracted.isVideoOnly || extracted.video) {
    return "video";
  }

  const hasTranscript =
    typeof extracted.transcriptCharacters === "number" && extracted.transcriptCharacters > 0;
  if (!hasTranscript) return null;
  return "audio";
}

function buildCompactTranscriptPart(extracted: ExtractedForLengths): FinishPart | null {
  const isYouTube = extracted.siteName === "YouTube" || isYouTubeUrl(extracted.url);
  if (!isYouTube && !extracted.transcriptCharacters) return null;

  const transcriptChars = extracted.transcriptCharacters;
  if (typeof transcriptChars !== "number" || transcriptChars <= 0) return null;

  const wordEstimate = Math.max(0, Math.round(transcriptChars / 6));
  const transcriptWords = extracted.transcriptWordCount ?? wordEstimate;
  const minutesEstimate = Math.max(0.1, transcriptWords / 160);

  const exactDurationSeconds =
    typeof extracted.mediaDurationSeconds === "number" && extracted.mediaDurationSeconds > 0
      ? extracted.mediaDurationSeconds
      : null;

  const mediaKind = inferMediaKindLabelForFinishLine(extracted);
  const kindLabel = (() => {
    if (isYouTube) return "YouTube";
    if (mediaKind === "audio") return "podcast";
    if (mediaKind === "video") return "video";
    return null;
  })();

  return {
    kind: "compactTranscript",
    durationSeconds: exactDurationSeconds ?? minutesEstimate * 60,
    approximate: exactDurationSeconds === null,
    media: kindLabel ?? "generic",
    words: transcriptWords,
  };
}

function buildDetailedLengthPartsForExtracted(extracted: ExtractedForLengths): FinishPart[] {
  const parts: FinishPart[] = [];
  const isYouTube = extracted.siteName === "YouTube" || isYouTubeUrl(extracted.url);
  if (!isYouTube && !extracted.transcriptCharacters) return parts;

  const transcriptChars = extracted.transcriptCharacters;
  const shouldOmitInput =
    typeof transcriptChars === "number" &&
    transcriptChars > 0 &&
    extracted.totalCharacters > 0 &&
    transcriptChars / extracted.totalCharacters >= 0.95;
  if (!shouldOmitInput) {
    parts.push({
      kind: "length",
      ...cliMessage("finish.inputLength", {
        chars: extracted.totalCharacters,
        words: extracted.wordCount,
      }),
    });
  }

  if (typeof extracted.transcriptCharacters === "number" && extracted.transcriptCharacters > 0) {
    const wordEstimate = Math.max(0, Math.round(extracted.transcriptCharacters / 6));
    const transcriptWords = extracted.transcriptWordCount ?? wordEstimate;
    const minutesEstimate = Math.max(0.1, transcriptWords / 160);
    const exactSeconds =
      typeof extracted.mediaDurationSeconds === "number" && extracted.mediaDurationSeconds > 0
        ? extracted.mediaDurationSeconds
        : null;
    parts.push({
      kind: "length",
      ...cliMessage("finish.transcriptLength", {
        durationSeconds: exactSeconds ?? minutesEstimate * 60,
        approximate: exactSeconds === null,
        words: transcriptWords,
        chars: extracted.transcriptCharacters,
      }),
    });
  }

  const hasTranscript =
    typeof extracted.transcriptCharacters === "number" && extracted.transcriptCharacters > 0;
  if (hasTranscript && extracted.transcriptSource) {
    const providerSuffix =
      extracted.transcriptSource === "whisper" &&
      extracted.transcriptionProvider &&
      extracted.transcriptionProvider.trim().length > 0
        ? `/${extracted.transcriptionProvider.trim()}`
        : "";
    const cacheStatus = extracted.diagnostics?.transcript?.cacheStatus;
    const cachePart =
      typeof cacheStatus === "string" && cacheStatus !== "unknown" ? cacheStatus : null;
    const txParts: string[] = [`tx=${extracted.transcriptSource}${providerSuffix}`];
    if (cachePart) txParts.push(`cache=${cachePart}`);
    parts.push(txParts.join(" "));
  }
  return parts;
}

export function buildLengthPartsForFinishLine(
  extracted: ExtractedForLengths,
  detailed: boolean,
): FinishPart[] | null {
  const compactTranscript = buildCompactTranscriptPart(extracted);
  if (!detailed) return compactTranscript ? [compactTranscript] : null;

  const parts = buildDetailedLengthPartsForExtracted(extracted);
  if (parts.length === 0 && !compactTranscript) return null;
  if (compactTranscript) parts.unshift(compactTranscript);
  return parts;
}
