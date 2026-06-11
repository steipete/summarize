import type { ExtractedLinkContent, TranscriptSegment } from "@steipete/summarize-core/content";
import { applyContentBudget, formatTimestampMs } from "@steipete/summarize-core/content";
import { hashJson } from "../cache-keys.js";
import type { LlmTokenUsage } from "../llm/types.js";
import {
  inferSpeakerMappingsWithOpenAi,
  type InferSpeakerMappingsResult,
  type OpenAiSpeakerMapping,
} from "./openai.js";
import type {
  SpeakerAnchor,
  SpeakerIdentificationSettings,
  SpeakerIdentityMapping,
} from "./types.js";

const GENERIC_SPEAKER_PATTERN = /^Speaker (?:\d+|[A-Z])$/;
const MAX_ANCHOR_DISTANCE_MS = 5_000;

export class SpeakerIdentificationError extends Error {
  override name = "SpeakerIdentificationError";
}

export type SpeakerIdentificationResult = {
  extracted: ExtractedLinkContent;
  mappings: SpeakerIdentityMapping[];
  transcriptHash: string | null;
  usage: LlmTokenUsage | null;
  warning: string | null;
  cacheable: boolean;
};

type InferMappings = (args: {
  segments: TranscriptSegment[];
  unresolvedSpeakers: string[];
  anchoredMappings: Record<string, string>;
  title: string | null;
  description: string | null;
  sourceUrl: string;
  settings: SpeakerIdentificationSettings;
  apiKey: string;
  baseUrl: string | null;
  timeoutMs: number;
  fetchImpl: typeof fetch;
}) => Promise<InferSpeakerMappingsResult>;

function normalizeSegments(raw: unknown): TranscriptSegment[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((entry): TranscriptSegment | null => {
      if (!entry || typeof entry !== "object") return null;
      const record = entry as Record<string, unknown>;
      const startMs = typeof record.startMs === "number" ? record.startMs : Number.NaN;
      const text = typeof record.text === "string" ? record.text.trim() : "";
      const speaker = typeof record.speaker === "string" ? record.speaker.trim() : "";
      const endMs = typeof record.endMs === "number" ? record.endMs : null;
      if (!Number.isFinite(startMs) || startMs < 0 || !text || !speaker) return null;
      return { startMs, endMs, text, speaker };
    })
    .filter((segment): segment is TranscriptSegment => segment !== null);
}

function extractRawSegments(extracted: ExtractedLinkContent): TranscriptSegment[] {
  const metadataSegments = extracted.transcriptMetadata?.segments;
  const fromMetadata = normalizeSegments(metadataSegments);
  return fromMetadata.length > 0 ? fromMetadata : normalizeSegments(extracted.transcriptSegments);
}

function isGenericSpeaker(value: string | null | undefined): value is string {
  return Boolean(value && GENERIC_SPEAKER_PATTERN.test(value));
}

function segmentDistanceMs(segments: TranscriptSegment[], index: number, atMs: number): number {
  const segment = segments[index]!;
  const nextStart = segments[index + 1]?.startMs;
  const endMs =
    typeof segment.endMs === "number" && segment.endMs >= segment.startMs
      ? segment.endMs
      : typeof nextStart === "number"
        ? nextStart
        : segment.startMs;
  if (atMs >= segment.startMs && atMs <= endMs) return 0;
  return Math.min(Math.abs(atMs - segment.startMs), Math.abs(atMs - endMs));
}

function resolveAnchorSpeaker(segments: TranscriptSegment[], anchor: SpeakerAnchor): string {
  const exactStart = segments.find(
    (segment) => isGenericSpeaker(segment.speaker) && segment.startMs === anchor.atMs,
  );
  if (exactStart?.speaker) return exactStart.speaker;

  let best: { speaker: string; distanceMs: number } | null = null;
  for (const [index, segment] of segments.entries()) {
    if (!isGenericSpeaker(segment.speaker)) continue;
    const distanceMs = segmentDistanceMs(segments, index, anchor.atMs);
    if (!best || distanceMs < best.distanceMs) best = { speaker: segment.speaker, distanceMs };
  }
  if (!best || best.distanceMs > MAX_ANCHOR_DISTANCE_MS) {
    throw new SpeakerIdentificationError(
      `No diarized speaker found near ${formatTimestampMs(anchor.atMs)} for "${anchor.name}".`,
    );
  }
  return best.speaker;
}

function normalizeName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const name = value.replace(/\s+/g, " ").trim();
  if (name.length < 2 || name.length > 100 || isGenericSpeaker(name)) return null;
  return name;
}

function addMapping(
  mappings: Map<string, SpeakerIdentityMapping>,
  mapping: SpeakerIdentityMapping,
): void {
  const existing = mappings.get(mapping.speaker);
  if (existing?.source === "anchor") {
    if (
      mapping.source === "anchor" &&
      existing.name.toLocaleLowerCase() !== mapping.name.toLocaleLowerCase()
    ) {
      throw new SpeakerIdentificationError(
        `Conflicting names for ${mapping.speaker}: "${existing.name}" and "${mapping.name}".`,
      );
    }
    return;
  }
  if (!existing || mapping.confidence > existing.confidence || mapping.source === "anchor") {
    mappings.set(mapping.speaker, mapping);
  }
}

function replaceSpeakerLabels(input: string | null, mappings: Map<string, string>): string | null {
  if (!input || mappings.size === 0) return input;
  const labels = [...mappings.keys()]
    .sort((a, b) => b.length - a.length)
    .map((label) => label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const pattern = new RegExp(`(^|\\n)(\\[[^\\]\\n]+\\]\\s+)?(${labels.join("|")})(?=:)`, "g");
  return input.replace(pattern, (_match, lineStart: string, timestamp: string, label: string) => {
    return `${lineStart}${timestamp ?? ""}${mappings.get(label) ?? label}`;
  });
}

function formatTranscript(segments: TranscriptSegment[]): string {
  return segments
    .map((segment) => `${segment.speaker}: ${segment.text.replace(/\s+/g, " ").trim()}`)
    .join("\n");
}

function countWords(value: string): number {
  const trimmed = value.trim();
  return trimmed ? trimmed.split(/\s+/).length : 0;
}

function appendNote(existing: string | null | undefined, note: string): string {
  return existing ? `${existing}; ${note}` : note;
}

function applyMappingsToExtracted({
  extracted,
  rawSegments,
  mappings,
  settings,
  transcriptHash,
  maxContentCharacters,
}: {
  extracted: ExtractedLinkContent;
  rawSegments: TranscriptSegment[];
  mappings: SpeakerIdentityMapping[];
  settings: SpeakerIdentificationSettings;
  transcriptHash: string;
  maxContentCharacters: number | null;
}): ExtractedLinkContent {
  const names = new Map(mappings.map((mapping) => [mapping.speaker, mapping.name]));
  const mappedSegments = rawSegments.map((segment) => ({
    ...segment,
    speaker: segment.speaker ? (names.get(segment.speaker) ?? segment.speaker) : segment.speaker,
  }));
  const rawTranscript = formatTranscript(rawSegments);
  const mappedTranscript = formatTranscript(mappedSegments);
  const unresolved = [...new Set(mappedSegments.map((segment) => segment.speaker))].filter(
    isGenericSpeaker,
  );
  const status =
    unresolved.length === 0 ? "complete" : mappings.length > 0 ? "partial" : "unresolved";
  const mappedContent = replaceSpeakerLabels(extracted.content, names) ?? extracted.content;
  const mappedTotalCharacters = Math.max(
    0,
    extracted.totalCharacters + mappedTranscript.length - rawTranscript.length,
  );
  const budgetedContent =
    typeof maxContentCharacters === "number"
      ? applyContentBudget(mappedContent, maxContentCharacters)
      : {
          content: mappedContent,
          truncated: false,
          totalCharacters: mappedContent.length,
          wordCount: countWords(mappedContent),
        };
  const exceedsBudget =
    typeof maxContentCharacters === "number" && mappedTotalCharacters > maxContentCharacters;
  const transcriptTimedText = replaceSpeakerLabels(extracted.transcriptTimedText, names);
  const transcriptSegments = extracted.transcriptSegments
    ? normalizeSegments(extracted.transcriptSegments).map((segment) => ({
        ...segment,
        speaker: segment.speaker
          ? (names.get(segment.speaker) ?? segment.speaker)
          : segment.speaker,
      }))
    : null;
  const metadata = {
    ...(extracted.transcriptMetadata ?? {}),
    segments: mappedSegments,
    speakerIdentification: {
      status,
      profile: settings.profileName,
      model: settings.model,
      minimumConfidence: settings.minimumConfidence,
      transcriptHash,
      mappings,
      unresolved,
    },
  };
  return {
    ...extracted,
    content: budgetedContent.content,
    truncated: extracted.truncated || budgetedContent.truncated || exceedsBudget,
    totalCharacters: Math.max(mappedTotalCharacters, budgetedContent.totalCharacters),
    wordCount: budgetedContent.wordCount,
    transcriptCharacters: mappedTranscript.length,
    transcriptLines: mappedSegments.length,
    transcriptWordCount: countWords(mappedTranscript),
    transcriptMetadata: metadata,
    transcriptSegments,
    transcriptTimedText,
    diagnostics: {
      ...extracted.diagnostics,
      transcript: {
        ...extracted.diagnostics.transcript,
        notes: appendNote(
          extracted.diagnostics.transcript.notes,
          `Speaker identification ${status} (${mappings.length} mapped)`,
        ),
      },
    },
  };
}

function validateOpenAiMapping(
  raw: OpenAiSpeakerMapping,
  unresolved: Set<string>,
  minimumConfidence: number,
): SpeakerIdentityMapping | null {
  if (!raw || typeof raw !== "object" || !unresolved.has(raw.speaker)) return null;
  const name = normalizeName(raw.name);
  const confidence = Number(raw.confidence);
  if (!name || !Number.isFinite(confidence) || confidence < minimumConfidence || confidence > 1) {
    return null;
  }
  const evidence = typeof raw.evidence === "string" ? raw.evidence.replace(/\s+/g, " ").trim() : "";
  return {
    speaker: raw.speaker,
    name,
    confidence,
    source: "openai",
    evidence: evidence || null,
  };
}

export async function identifySpeakersInExtractedContent({
  extracted,
  sourceUrl,
  settings,
  openaiApiKey,
  openaiBaseUrl,
  timeoutMs,
  maxContentCharacters,
  fetchImpl,
  inferMappings = inferSpeakerMappingsWithOpenAi,
}: {
  extracted: ExtractedLinkContent;
  sourceUrl: string;
  settings: SpeakerIdentificationSettings;
  openaiApiKey: string | null;
  openaiBaseUrl: string | null;
  timeoutMs: number;
  maxContentCharacters: number | null;
  fetchImpl: typeof fetch;
  inferMappings?: InferMappings;
}): Promise<SpeakerIdentificationResult> {
  const rawSegments = extractRawSegments(extracted);
  if (rawSegments.length === 0) {
    return {
      extracted,
      mappings: [],
      transcriptHash: null,
      usage: null,
      warning: "Speaker identification skipped because diarization returned no timed segments.",
      cacheable: false,
    };
  }

  const transcriptHash = hashJson(rawSegments);
  const genericSpeakers = [...new Set(rawSegments.map((segment) => segment.speaker))].filter(
    isGenericSpeaker,
  );
  const genericSet = new Set(genericSpeakers);
  const mappings = new Map<string, SpeakerIdentityMapping>();

  for (const anchor of settings.anchors) {
    const speaker = resolveAnchorSpeaker(rawSegments, anchor);
    addMapping(mappings, {
      speaker,
      name: anchor.name,
      confidence: 1,
      source: "anchor",
      evidence: `Timestamp ${formatTimestampMs(anchor.atMs)}`,
    });
  }

  if (settings.remembered?.transcriptHash.toLowerCase() === transcriptHash) {
    for (const [speaker, rawName] of Object.entries(settings.remembered.mappings)) {
      const name = normalizeName(rawName);
      if (!genericSet.has(speaker) || !name) continue;
      addMapping(mappings, { speaker, name, confidence: 1, source: "remembered" });
    }
  }

  const unresolvedSpeakers = genericSpeakers.filter((speaker) => !mappings.has(speaker));
  let usage: LlmTokenUsage | null = null;
  let warning: string | null = null;
  if (unresolvedSpeakers.length > 0 && openaiApiKey) {
    try {
      const inferred = await inferMappings({
        segments: rawSegments,
        unresolvedSpeakers,
        anchoredMappings: Object.fromEntries(
          [...mappings.values()].map((mapping) => [mapping.speaker, mapping.name]),
        ),
        title: extracted.title,
        description: extracted.description,
        sourceUrl,
        settings,
        apiKey: openaiApiKey,
        baseUrl: openaiBaseUrl,
        timeoutMs,
        fetchImpl,
      });
      usage = inferred.usage;
      const unresolved = new Set(unresolvedSpeakers);
      for (const raw of inferred.mappings) {
        const mapping = validateOpenAiMapping(raw, unresolved, settings.minimumConfidence);
        if (mapping) addMapping(mappings, mapping);
      }
    } catch (error) {
      warning = `OpenAI speaker identification failed: ${error instanceof Error ? error.message : String(error)}`;
    }
  } else if (unresolvedSpeakers.length > 0) {
    warning = "OpenAI speaker identification skipped because OPENAI_API_KEY is unavailable.";
  }

  const resolvedMappings = [...mappings.values()].sort((a, b) =>
    a.speaker.localeCompare(b.speaker, undefined, { numeric: true }),
  );
  const identified = applyMappingsToExtracted({
    extracted,
    rawSegments,
    mappings: resolvedMappings,
    settings,
    transcriptHash,
    maxContentCharacters,
  });
  return {
    extracted: identified,
    mappings: resolvedMappings,
    transcriptHash,
    usage,
    warning,
    cacheable: !warning,
  };
}
