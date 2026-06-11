import {
  env,
  pipeline,
  type AutomaticSpeechRecognitionOutput,
  type AutomaticSpeechRecognitionPipelineType,
} from "@huggingface/transformers";

const WHISPER_MODEL = "onnx-community/whisper-tiny";
const WEBGPU_MODEL_LOAD_TIMEOUT_MS = 30_000;
const WASM_MODEL_LOAD_TIMEOUT_MS = 90_000;
const ORT_WASM_URL = new URL(
  "../../../node_modules/@huggingface/transformers/dist/ort-wasm-simd-threaded.jsep.wasm",
  import.meta.url,
).href;
let transcriberPromise: Promise<AutomaticSpeechRecognitionPipelineType> | null = null;
type WhisperDevice = "webgpu" | "wasm";
type WhisperPipelineFactory = (
  device: WhisperDevice,
  onStatus: (status: string) => void,
) => Promise<AutomaticSpeechRecognitionPipelineType>;

export async function transcribePcmWithWhisper({
  audio,
  maxChars,
  onStatus,
}: {
  audio: Float32Array;
  maxChars: number;
  onStatus: (status: string) => void;
}): Promise<{ text: string; transcriptTimedText: string; truncated: boolean }> {
  if (audio.length === 0) throw new Error("The decoded YouTube audio is empty.");
  const transcriber = await getTranscriber(onStatus);
  onStatus("Transcribing YouTube audio locally...");
  const output = await transcriber(audio, {
    chunk_length_s: 30,
    stride_length_s: 5,
    return_timestamps: true,
  });
  const resolved = Array.isArray(output) ? output[0] : output;
  if (!resolved) throw new Error("Local Whisper returned no transcript.");
  return formatWhisperOutput(resolved, maxChars);
}

async function getTranscriber(
  onStatus: (status: string) => void,
): Promise<AutomaticSpeechRecognitionPipelineType> {
  if (!transcriberPromise) {
    const hasWebGpu = "gpu" in navigator;
    env.allowLocalModels = false;
    env.allowRemoteModels = true;
    env.useBrowserCache = true;
    if (env.backends.onnx.wasm) {
      env.backends.onnx.wasm.wasmPaths = {
        mjs: chrome.runtime.getURL("assets/ort-wasm-simd-threaded.jsep.mjs"),
        wasm: ORT_WASM_URL,
      };
      env.backends.onnx.wasm.proxy = false;
    }
    transcriberPromise = loadWhisperTranscriber({
      hasWebGpu,
      onStatus,
    }).catch((error) => {
      transcriberPromise = null;
      throw error;
    });
  }
  return await transcriberPromise;
}

export async function loadWhisperTranscriber({
  hasWebGpu,
  onStatus,
  createPipeline = createWhisperPipeline,
  webGpuTimeoutMs = WEBGPU_MODEL_LOAD_TIMEOUT_MS,
  wasmTimeoutMs = WASM_MODEL_LOAD_TIMEOUT_MS,
}: {
  hasWebGpu: boolean;
  onStatus: (status: string) => void;
  createPipeline?: WhisperPipelineFactory;
  webGpuTimeoutMs?: number;
  wasmTimeoutMs?: number;
}): Promise<AutomaticSpeechRecognitionPipelineType> {
  let activeAttempt = 0;
  const load = async (device: WhisperDevice, timeoutMs: number, timeoutMessage: string) => {
    const attempt = ++activeAttempt;
    return await withTimeout(
      createPipeline(device, (status) => {
        if (attempt === activeAttempt) onStatus(status);
      }),
      timeoutMs,
      timeoutMessage,
    );
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

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function formatWhisperOutput(
  output: AutomaticSpeechRecognitionOutput,
  maxChars: number,
): { text: string; transcriptTimedText: string; truncated: boolean } {
  const text = normalizeText(output.text);
  const timedLines = (output.chunks ?? []).flatMap((chunk) => {
    const chunkText = normalizeText(chunk.text);
    const start = Array.isArray(chunk.timestamp) ? chunk.timestamp[0] : null;
    if (!chunkText || typeof start !== "number" || !Number.isFinite(start)) return [];
    return [`[${formatTimestamp(start)}] ${chunkText}`];
  });
  return clampTranscript(text, timedLines.join("\n"), maxChars);
}

function clampTranscript(
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
