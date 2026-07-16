import { isYouTubeUrl } from "@steipete/summarize-core/content/url";
import {
  formatCompactCount,
  formatDurationSecondsSmart,
  formatMinutesSmart,
} from "../tty/format.js";

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

function buildCompactTranscriptPart(extracted: ExtractedForLengths): string | null {
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
  const duration =
    exactDurationSeconds != null
      ? formatDurationSecondsSmart(exactDurationSeconds)
      : formatMinutesSmart(minutesEstimate);

  const wordLabel = `${formatCompactCount(transcriptWords)} words`;
  const mediaKind = inferMediaKindLabelForFinishLine(extracted);
  const kindLabel = (() => {
    if (isYouTube) return "YouTube";
    if (mediaKind === "audio") return "podcast";
    if (mediaKind === "video") return "video";
    return null;
  })();

  return kindLabel ? `${duration} ${kindLabel} · ${wordLabel}` : `${duration} · ${wordLabel}`;
}

function buildDetailedLengthPartsForExtracted(extracted: ExtractedForLengths): string[] {
  const parts: string[] = [];
  const isYouTube = extracted.siteName === "YouTube" || isYouTubeUrl(extracted.url);
  if (!isYouTube && !extracted.transcriptCharacters) return parts;

  const transcriptChars = extracted.transcriptCharacters;
  const shouldOmitInput =
    typeof transcriptChars === "number" &&
    transcriptChars > 0 &&
    extracted.totalCharacters > 0 &&
    transcriptChars / extracted.totalCharacters >= 0.95;
  if (!shouldOmitInput) {
    parts.push(
      `input=${formatCompactCount(extracted.totalCharacters)} chars (~${formatCompactCount(extracted.wordCount)} words)`,
    );
  }

  if (typeof extracted.transcriptCharacters === "number" && extracted.transcriptCharacters > 0) {
    const wordEstimate = Math.max(0, Math.round(extracted.transcriptCharacters / 6));
    const transcriptWords = extracted.transcriptWordCount ?? wordEstimate;
    const minutesEstimate = Math.max(0.1, transcriptWords / 160);
    const details: string[] = [
      `~${formatCompactCount(transcriptWords)} words`,
      `${formatCompactCount(extracted.transcriptCharacters)} chars`,
    ];
    const durationPart =
      typeof extracted.mediaDurationSeconds === "number" && extracted.mediaDurationSeconds > 0
        ? formatDurationSecondsSmart(extracted.mediaDurationSeconds)
        : formatMinutesSmart(minutesEstimate);

    parts.push(`transcript=${durationPart} (${details.join(" · ")})`);
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
): string[] | null {
  const compactTranscript = buildCompactTranscriptPart(extracted);
  if (!detailed) return compactTranscript ? [`txc=${compactTranscript}`] : null;

  const parts = buildDetailedLengthPartsForExtracted(extracted);
  if (parts.length === 0 && !compactTranscript) return null;
  if (compactTranscript) parts.unshift(`txc=${compactTranscript}`);
  return parts;
}
