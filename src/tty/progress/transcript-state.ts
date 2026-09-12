import type { LinkPreviewProgressEvent } from "@steipete/summarize-core/content";
import {
  formatBytes,
  formatBytesPerSecond,
  formatDurationSecondsSmart,
  formatElapsedMs,
} from "../format.js";
import type { ThemeRenderer } from "../theme.js";

export type TranscriptProgressState = {
  phase: "idle" | "download" | "whisper";
  service: "youtube" | "podcast" | "generic";
  downloadedBytes: number;
  totalBytes: number | null;
  startedAtMs: number | null;
  whisperProviderHint: string;
  mediaKind: "video" | "audio" | "unknown";
  whisperModelId: string | null;
  whisperProcessedSeconds: number | null;
  whisperTotalSeconds: number | null;
  whisperPartIndex: number | null;
  whisperParts: number | null;
};

export function createTranscriptProgressState(): TranscriptProgressState {
  return {
    phase: "idle",
    service: "generic",
    downloadedBytes: 0,
    totalBytes: null,
    startedAtMs: null,
    whisperProviderHint: "unknown",
    mediaKind: "audio",
    whisperModelId: null,
    whisperProcessedSeconds: null,
    whisperTotalSeconds: null,
    whisperPartIndex: null,
    whisperParts: null,
  };
}

export function applyTranscriptProgressEvent(
  state: TranscriptProgressState,
  event: LinkPreviewProgressEvent,
  nowMs: number,
): void {
  if (event.kind === "transcript-media-download-start") {
    state.phase = "download";
    state.service = event.service;
    state.mediaKind = event.mediaKind ?? state.mediaKind;
    state.downloadedBytes = 0;
    state.totalBytes = event.totalBytes;
    state.startedAtMs = nowMs;
    return;
  }

  if (event.kind === "transcript-media-download-progress") {
    const enteringPhase = state.phase !== "download";
    state.phase = "download";
    state.service = event.service;
    state.mediaKind = event.mediaKind ?? state.mediaKind;
    state.downloadedBytes = event.downloadedBytes;
    state.totalBytes = event.totalBytes;
    if (enteringPhase || state.startedAtMs == null) state.startedAtMs = nowMs;
    return;
  }

  if (event.kind === "transcript-media-download-done") {
    const enteringPhase = state.phase !== "download";
    state.phase = "download";
    state.service = event.service;
    state.mediaKind = event.mediaKind ?? state.mediaKind;
    state.downloadedBytes = event.downloadedBytes;
    state.totalBytes = event.totalBytes;
    if (enteringPhase || state.startedAtMs == null) state.startedAtMs = nowMs;
    return;
  }

  if (event.kind === "transcript-whisper-start") {
    state.phase = "whisper";
    state.service = event.service;
    state.whisperProviderHint = event.providerHint;
    state.whisperModelId = event.modelId;
    state.whisperProcessedSeconds = null;
    state.whisperTotalSeconds = event.totalDurationSeconds;
    state.whisperPartIndex = 0;
    state.whisperParts = event.parts;
    state.startedAtMs = nowMs;
    return;
  }

  if (event.kind === "transcript-whisper-progress") {
    const enteringPhase = state.phase !== "whisper";
    state.phase = "whisper";
    state.service = event.service;
    state.whisperProcessedSeconds = event.processedDurationSeconds;
    state.whisperTotalSeconds = event.totalDurationSeconds;
    state.whisperPartIndex = event.partIndex;
    state.whisperParts = event.parts;
    if (enteringPhase || state.startedAtMs == null) state.startedAtMs = nowMs;
  }
}

export function renderTranscriptSimple(
  state: TranscriptProgressState,
  theme?: ThemeRenderer | null,
): string | null {
  if (state.phase === "download") return renderSimple(downloadTitle(state), theme);
  if (state.phase === "whisper") return renderSimple("Transcribing", theme);
  return null;
}

export function renderTranscriptLine(
  state: TranscriptProgressState,
  {
    nowMs,
    theme,
  }: {
    nowMs: number;
    theme?: ThemeRenderer | null;
  },
): string | null {
  if (state.phase === "download") return renderDownloadLine(state, nowMs, theme);
  if (state.phase === "whisper") return renderWhisperLine(state, nowMs, theme);
  return null;
}

export function resolveTranscriptOscPayload(
  state: TranscriptProgressState,
): { label: string; percent: number | null } | null {
  if (state.phase === "download") {
    return { label: downloadTitle(state), percent: resolveDownloadPercent(state) };
  }
  if (state.phase === "whisper") {
    return { label: "Transcribing", percent: resolveWhisperPercent(state) };
  }
  return null;
}

function renderDownloadLine(
  state: TranscriptProgressState,
  nowMs: number,
  theme?: ThemeRenderer | null,
): string {
  const downloaded = formatBytes(state.downloadedBytes);
  const total =
    typeof state.totalBytes === "number" &&
    state.totalBytes > 0 &&
    state.downloadedBytes <= state.totalBytes
      ? `/${formatBytes(state.totalBytes)}`
      : "";
  const elapsedMs = typeof state.startedAtMs === "number" ? nowMs - state.startedAtMs : 0;
  const elapsed = formatElapsedMs(elapsedMs);
  const rate =
    elapsedMs > 0 && state.downloadedBytes > 0
      ? `, ${formatBytesPerSecond(state.downloadedBytes / (elapsedMs / 1000))}`
      : "";
  const svcLabel =
    state.service === "podcast" ? "podcast" : state.service === "youtube" ? "youtube" : "";
  return renderLine(
    `Downloading ${state.mediaKind === "video" ? "video" : "audio"}`,
    ` (${svcLabel ? `${svcLabel}, ` : ""}${downloaded}${total}, ${elapsed}${rate})…`,
    null,
    theme,
  );
}

function renderWhisperLine(
  state: TranscriptProgressState,
  nowMs: number,
  theme?: ThemeRenderer | null,
): string {
  const provider = formatProvider(firstChainPart(state.whisperProviderHint));
  const modelId = firstChainPart(state.whisperModelId);
  const providerLabel = modelId ? `${provider}, ${modelId}` : provider;
  const svc =
    state.service === "podcast" ? "podcast" : state.service === "youtube" ? "youtube" : "media";
  const elapsedMs = typeof state.startedAtMs === "number" ? nowMs - state.startedAtMs : 0;
  const elapsed = formatElapsedMs(elapsedMs);
  const percent =
    typeof state.whisperProcessedSeconds === "number" &&
    typeof state.whisperTotalSeconds === "number" &&
    state.whisperTotalSeconds > 0
      ? Math.min(
          100,
          Math.max(
            0,
            Math.round((state.whisperProcessedSeconds / state.whisperTotalSeconds) * 100),
          ),
        )
      : null;
  const duration =
    typeof state.whisperProcessedSeconds === "number" &&
    typeof state.whisperTotalSeconds === "number" &&
    state.whisperTotalSeconds > 0
      ? `, ${formatDurationSecondsSmart(state.whisperProcessedSeconds)}/${formatDurationSecondsSmart(
          state.whisperTotalSeconds,
        )}`
      : typeof state.whisperTotalSeconds === "number" && state.whisperTotalSeconds > 0
        ? `, ${formatDurationSecondsSmart(state.whisperTotalSeconds)}`
        : "";
  const parts =
    typeof state.whisperPartIndex === "number" &&
    typeof state.whisperParts === "number" &&
    state.whisperPartIndex > 0 &&
    state.whisperParts > 0
      ? `, ${state.whisperPartIndex}/${state.whisperParts}`
      : "";
  return renderLine(
    "Transcribing",
    ` (${svc}, ${providerLabel}${duration}${parts}, ${elapsed})…`,
    typeof percent === "number" ? `${percent}%` : null,
    theme,
  );
}

function renderLine(
  label: string,
  detail: string,
  percentLabel: string | null,
  theme?: ThemeRenderer | null,
): string {
  if (!theme) return `${label}${percentLabel ? ` ${percentLabel}` : ""}${detail}`;
  const percent = percentLabel ? ` ${theme.value(percentLabel)}` : "";
  return `${theme.label(label)}${percent}${theme.dim(detail)}`;
}

function renderSimple(label: string, theme?: ThemeRenderer | null): string {
  return theme ? `${theme.label(label)}${theme.dim("…")}` : `${label}…`;
}

function downloadTitle(state: TranscriptProgressState): string {
  return state.mediaKind === "video" ? "Downloading video" : "Downloading audio";
}

function resolveDownloadPercent(state: TranscriptProgressState): number | null {
  if (typeof state.totalBytes !== "number" || state.totalBytes <= 0) return null;
  if (state.downloadedBytes <= 0) return 0;
  return (state.downloadedBytes / state.totalBytes) * 100;
}

function resolveWhisperPercent(state: TranscriptProgressState): number | null {
  if (typeof state.whisperTotalSeconds === "number" && state.whisperTotalSeconds > 0) {
    const processed =
      typeof state.whisperProcessedSeconds === "number" ? state.whisperProcessedSeconds : 0;
    return (processed / state.whisperTotalSeconds) * 100;
  }
  if (typeof state.whisperParts === "number" && state.whisperParts > 0) {
    const index = typeof state.whisperPartIndex === "number" ? state.whisperPartIndex : 0;
    return (index / state.whisperParts) * 100;
  }
  return null;
}

function formatProvider(hint: string): string {
  if (hint === "cpp") return "Whisper.cpp";
  if (hint === "onnx") return "ONNX (Parakeet/Canary)";
  if (hint === "groq") return "Whisper/Groq";
  if (hint === "assemblyai") return "AssemblyAI";
  if (hint === "gemini") return "Gemini";
  if (hint === "openai") return "Whisper/OpenAI";
  if (hint === "fal") return "Whisper/FAL";
  return "Whisper";
}

function firstChainPart(value: string): string;
function firstChainPart(value: string | null): string | null;
function firstChainPart(value: string | null): string | null {
  return value?.split("->", 1)[0]?.trim() || null;
}
