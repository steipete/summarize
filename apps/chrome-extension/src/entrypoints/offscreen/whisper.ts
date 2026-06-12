import {
  env,
  pipeline,
  type AutomaticSpeechRecognitionOutput,
  type AutomaticSpeechRecognitionPipelineType,
} from "@huggingface/transformers";

const WHISPER_MODEL = "onnx-community/whisper-tiny";
const WEBGPU_MODEL_LOAD_TIMEOUT_MS = 30_000;
const WASM_MODEL_LOAD_TIMEOUT_MS = 90_000;
const WHISPER_IDLE_DISPOSE_MS = 5 * 60 * 1000;
type WhisperDevice = "webgpu" | "wasm";
type WhisperPipelineFactory = (
  device: WhisperDevice,
  onStatus: (status: string) => void,
) => Promise<AutomaticSpeechRecognitionPipelineType>;
type WhisperRuntime = {
  device: WhisperDevice;
  loadMs: number;
  transcriber: AutomaticSpeechRecognitionPipelineType;
};

export type WhisperRuntimeDiagnostics = {
  device: WhisperDevice;
  loadMs: number;
  reused: boolean;
};

export type WhisperChunkTranscript = {
  diagnostics: WhisperRuntimeDiagnostics;
  text: string;
  timedLines: string[];
};

let transcriberPromise: Promise<WhisperRuntime> | null = null;
let transcriberRuntime: WhisperRuntime | null = null;
let transcriberIdleTimer: ReturnType<typeof setTimeout> | null = null;
let activeTranscriptions = 0;

export async function transcribePcmWithWhisper({
  audio,
  maxChars,
  onStatus,
}: {
  audio: Float32Array;
  maxChars: number;
  onStatus: (status: string) => void;
}): Promise<{ text: string; transcriptTimedText: string; truncated: boolean }> {
  const chunk = await transcribePcmChunkWithWhisper({
    audio,
    onStatus,
    timestampOffsetSeconds: 0,
  });
  return clampWhisperTranscript(chunk.text, chunk.timedLines.join("\n"), maxChars);
}

export async function transcribePcmChunkWithWhisper({
  audio,
  onStatus,
  transcribingStatus = "Transcribing audio locally...",
  timestampOffsetSeconds,
}: {
  audio: Float32Array;
  onStatus: (status: string) => void;
  transcribingStatus?: string;
  timestampOffsetSeconds: number;
}): Promise<WhisperChunkTranscript> {
  if (audio.length === 0) throw new Error("The decoded YouTube audio is empty.");
  clearTranscriberIdleTimer();
  activeTranscriptions += 1;
  try {
    const { diagnostics, transcriber } = await getTranscriber(onStatus);
    onStatus(transcribingStatus);
    const output = await transcriber(audio, {
      chunk_length_s: 30,
      stride_length_s: 5,
      return_timestamps: true,
    });
    const resolved = Array.isArray(output) ? output[0] : output;
    if (!resolved) throw new Error("Local Whisper returned no transcript.");
    return { ...formatWhisperOutput(resolved, timestampOffsetSeconds), diagnostics };
  } finally {
    activeTranscriptions = Math.max(0, activeTranscriptions - 1);
    scheduleTranscriberDisposal();
  }
}

async function getTranscriber(onStatus: (status: string) => void): Promise<{
  diagnostics: WhisperRuntimeDiagnostics;
  transcriber: AutomaticSpeechRecognitionPipelineType;
}> {
  const reused = Boolean(transcriberPromise);
  if (!transcriberPromise) {
    const hasWebGpu = "gpu" in navigator;
    env.allowLocalModels = false;
    env.allowRemoteModels = true;
    env.useBrowserCache = true;
    if (env.backends.onnx.wasm) {
      env.backends.onnx.wasm.wasmPaths = {
        mjs: chrome.runtime.getURL("assets/ort-wasm-simd-threaded.asyncify.mjs"),
        wasm: chrome.runtime.getURL("assets/ort-wasm-simd-threaded.asyncify.wasm"),
      };
      env.backends.onnx.wasm.proxy = false;
    }
    const startedAt = performance.now();
    let loadedDevice: WhisperDevice = hasWebGpu ? "webgpu" : "wasm";
    transcriberPromise = loadWhisperTranscriber({
      hasWebGpu,
      onStatus,
      onDevice: (device) => {
        loadedDevice = device;
      },
    })
      .then((transcriber) => {
        const runtime = {
          device: loadedDevice,
          loadMs: Math.max(0, performance.now() - startedAt),
          transcriber,
        };
        transcriberRuntime = runtime;
        return runtime;
      })
      .catch((error) => {
        transcriberPromise = null;
        transcriberRuntime = null;
        throw error;
      });
  }
  const runtime = await transcriberPromise;
  return {
    transcriber: runtime.transcriber,
    diagnostics: {
      device: runtime.device,
      loadMs: runtime.loadMs,
      reused,
    },
  };
}

export async function loadWhisperTranscriber({
  hasWebGpu,
  onStatus,
  createPipeline = createWhisperPipeline,
  webGpuTimeoutMs = WEBGPU_MODEL_LOAD_TIMEOUT_MS,
  wasmTimeoutMs = WASM_MODEL_LOAD_TIMEOUT_MS,
  onDevice,
}: {
  hasWebGpu: boolean;
  onStatus: (status: string) => void;
  createPipeline?: WhisperPipelineFactory;
  webGpuTimeoutMs?: number;
  wasmTimeoutMs?: number;
  onDevice?: (device: WhisperDevice) => void;
}): Promise<AutomaticSpeechRecognitionPipelineType> {
  let activeAttempt = 0;
  const load = async (device: WhisperDevice, timeoutMs: number, timeoutMessage: string) => {
    const attempt = ++activeAttempt;
    const pipelinePromise = createPipeline(device, (status) => {
      if (attempt === activeAttempt) onStatus(status);
    });
    const loaded = await withTimeout(
      pipelinePromise,
      timeoutMs,
      timeoutMessage,
      async (latePipeline) => {
        await latePipeline.dispose();
      },
    );
    onDevice?.(device);
    return loaded;
  };

  if (hasWebGpu) {
    onStatus("Loading local Whisper model...");
    try {
      return await load(
        "webgpu",
        webGpuTimeoutMs,
        "WebGPU Whisper model initialization timed out.",
      );
    } catch {
      onStatus("WebGPU model load stalled; retrying on CPU...");
    }
  }

  onStatus("Loading local Whisper model (CPU)...");
  return await load("wasm", wasmTimeoutMs, "CPU Whisper model initialization timed out.");
}

async function createWhisperPipeline(
  device: WhisperDevice,
  onStatus: (status: string) => void,
): Promise<AutomaticSpeechRecognitionPipelineType> {
  return await pipeline("automatic-speech-recognition", WHISPER_MODEL, {
    device,
    dtype:
      device === "webgpu"
        ? { encoder_model: "fp16", decoder_model_merged: "q4" }
        : { encoder_model: "q8", decoder_model_merged: "q8" },
    progress_callback: (progress: unknown) => {
      if (!progress || typeof progress !== "object") return;
      const value = (progress as { progress?: unknown }).progress;
      if (typeof value !== "number" || !Number.isFinite(value)) return;
      onStatus(`Loading local Whisper model... ${Math.max(0, Math.min(100, Math.round(value)))}%`);
    },
  });
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
  onLateResolve?: (value: T) => Promise<void> | void,
): Promise<T> {
  return await new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      reject(new Error(message));
    }, timeoutMs);
    void promise.then(
      (value) => {
        if (settled) {
          void onLateResolve?.(value);
          return;
        }
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function formatWhisperOutput(
  output: AutomaticSpeechRecognitionOutput,
  timestampOffsetSeconds: number,
): { text: string; timedLines: string[] } {
  const text = normalizeText(output.text);
  const timedLines = (output.chunks ?? []).flatMap((chunk) => {
    const chunkText = normalizeText(chunk.text);
    const start = Array.isArray(chunk.timestamp) ? chunk.timestamp[0] : null;
    if (!chunkText || typeof start !== "number" || !Number.isFinite(start)) return [];
    return [`[${formatTimestamp(start + timestampOffsetSeconds)}] ${chunkText}`];
  });
  return { text, timedLines };
}

export function clampWhisperTranscript(
  text: string,
  timedText: string,
  maxChars: number,
): { text: string; transcriptTimedText: string; truncated: boolean } {
  const limit = Number.isFinite(maxChars) && maxChars > 0 ? Math.floor(maxChars) : text.length;
  if (text.length <= limit) return { text, transcriptTimedText: timedText, truncated: false };
  const suffix = "\n\n[TRUNCATED]";
  const clamped = `${text.slice(0, Math.max(0, limit - suffix.length))}${suffix}`;
  let timedLength = 0;
  const timedLines = timedText.split("\n").filter((line) => {
    timedLength += line.length + 1;
    return timedLength <= limit;
  });
  return { text: clamped, transcriptTimedText: timedLines.join("\n"), truncated: true };
}

export async function disposeWhisperTranscriber(): Promise<boolean> {
  clearTranscriberIdleTimer();
  if (activeTranscriptions > 0) return false;
  const runtime = transcriberRuntime;
  transcriberRuntime = null;
  transcriberPromise = null;
  if (!runtime) return false;
  await runtime.transcriber.dispose();
  return true;
}

function clearTranscriberIdleTimer(): void {
  if (!transcriberIdleTimer) return;
  clearTimeout(transcriberIdleTimer);
  transcriberIdleTimer = null;
}

function scheduleTranscriberDisposal(): void {
  clearTranscriberIdleTimer();
  if (activeTranscriptions > 0 || !transcriberRuntime) return;
  transcriberIdleTimer = setTimeout(() => {
    transcriberIdleTimer = null;
    void disposeWhisperTranscriber();
  }, WHISPER_IDLE_DISPOSE_MS);
}

function normalizeText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function formatTimestamp(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const remaining = whole % 60;
  const two = (value: number) => String(value).padStart(2, "0");
  return hours > 0 ? `${hours}:${two(minutes)}:${two(remaining)}` : `${minutes}:${two(remaining)}`;
}
