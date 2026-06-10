import { openAsBlob } from "node:fs";
import { basename } from "node:path";
import { MAX_ERROR_DETAIL_CHARS, TRANSCRIPTION_TIMEOUT_MS } from "./constants.js";
import { appendTranscriptToken, formatDiarizedTranscript } from "./diarization-format.js";
import type { TranscriptionSegment, WhisperTranscriptionResult } from "./types.js";

const ELEVENLABS_TRANSCRIPTION_URL = "https://api.elevenlabs.io/v1/speech-to-text";
export const ELEVENLABS_DIARIZATION_MODEL = "scribe_v2";

type ElevenLabsWord = {
  text?: unknown;
  start?: unknown;
  end?: unknown;
  speaker_id?: unknown;
};

type ElevenLabsPayload = {
  text?: unknown;
  words?: unknown;
};

export async function transcribeFileWithElevenLabsDiarization({
  filePath,
  mediaType,
  filename,
  apiKey,
  fetchImpl = globalThis.fetch,
  baseUrl = ELEVENLABS_TRANSCRIPTION_URL,
}: {
  filePath: string;
  mediaType: string;
  filename: string | null;
  apiKey: string;
  fetchImpl?: typeof fetch;
  baseUrl?: string;
}): Promise<WhisperTranscriptionResult> {
  const form = new FormData();
  const file = await openAsBlob(filePath, { type: mediaType });
  form.append("file", file, filename?.trim() || basename(filePath));
  form.append("model_id", ELEVENLABS_DIARIZATION_MODEL);
  form.append("diarize", "true");
  form.append("timestamps_granularity", "word");
  form.append("tag_audio_events", "false");

  const response = await fetchImpl(baseUrl, {
    method: "POST",
    headers: { "xi-api-key": apiKey },
    body: form,
    signal: AbortSignal.timeout(TRANSCRIPTION_TIMEOUT_MS),
  });
  if (!response.ok) {
    const detail = await readErrorDetail(response);
    const suffix = detail ? `: ${detail}` : "";
    throw new Error(`ElevenLabs transcription failed (${response.status})${suffix}`);
  }

  const payload = (await response.json()) as ElevenLabsPayload;
  const segments = parseElevenLabsDiarizedSegments(payload.words);
  const text = formatDiarizedTranscript(segments);
  if (!text) {
    throw new Error("ElevenLabs transcription returned no speaker-labelled segments");
  }
  return { text, provider: "elevenlabs", error: null, notes: [], segments };
}

export function parseElevenLabsDiarizedSegments(words: unknown): TranscriptionSegment[] {
  if (!Array.isArray(words)) return [];
  const segments: TranscriptionSegment[] = [];
  const speakerLabels = new Map<string, string>();

  for (const entry of words as ElevenLabsWord[]) {
    const token = typeof entry?.text === "string" ? entry.text : "";
    if (!token) continue;
    const rawSpeaker = typeof entry.speaker_id === "string" ? entry.speaker_id.trim() : "";
    const speaker =
      rawSpeaker.length > 0
        ? resolveSpeakerLabel(speakerLabels, rawSpeaker)
        : (segments.at(-1)?.speaker ?? "Speaker 1");
    const startMs = parseSecondsToMs(entry.start) ?? segments.at(-1)?.endMs ?? 0;
    const endMs = parseSecondsToMs(entry.end);
    const current = segments.at(-1);
    if (current?.speaker === speaker) {
      current.text = appendTranscriptToken(current.text, token);
      if (endMs != null) current.endMs = endMs;
      continue;
    }
    segments.push({
      startMs,
      endMs,
      text: appendTranscriptToken("", token),
      speaker,
    });
  }

  return segments
    .map((segment) => ({ ...segment, text: segment.text.trim() }))
    .filter((segment) => segment.text.length > 0);
}

function resolveSpeakerLabel(labels: Map<string, string>, rawSpeaker: string): string {
  const existing = labels.get(rawSpeaker);
  if (existing) return existing;
  const label = `Speaker ${labels.size + 1}`;
  labels.set(rawSpeaker, label);
  return label;
}

function parseSecondsToMs(value: unknown): number | null {
  const numeric = typeof value === "number" ? value : Number.NaN;
  return Number.isFinite(numeric) && numeric >= 0 ? Math.round(numeric * 1000) : null;
}

async function readErrorDetail(response: Response): Promise<string | null> {
  try {
    const text = (await response.text()).trim();
    if (!text) return null;
    return text.length > MAX_ERROR_DETAIL_CHARS
      ? `${text.slice(0, MAX_ERROR_DETAIL_CHARS)}…`
      : text;
  } catch {
    return null;
  }
}
