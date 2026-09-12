import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TRANSCRIPTION_TIMEOUT_MS } from "./constants.js";
import { ensureWhisperFilenameExtension, readErrorDetail, toArrayBuffer } from "./utils.js";

const GROQ_TRANSCRIPT_URL = "https://api.groq.com/openai/v1/audio/transcriptions";

export async function transcribeWithGroq(
  bytes: Uint8Array,
  mediaType: string,
  filename: string | null,
  apiKey: string,
): Promise<string | null> {
  const form = new FormData();
  const providedName = filename?.trim() ? filename.trim() : "media";
  const safeName = ensureWhisperFilenameExtension(providedName, mediaType);
  form.append("file", new Blob([toArrayBuffer(bytes)], { type: mediaType }), safeName);
  form.append("model", "whisper-large-v3-turbo");

  const response = await globalThis.fetch(GROQ_TRANSCRIPT_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
    signal: AbortSignal.timeout(TRANSCRIPTION_TIMEOUT_MS),
  });

  if (!response.ok) {
    const detail = await readErrorDetail(response);
    if (response.status === 403) {
      const fallback = await tryGroqCurlFallback({ bytes, mediaType, safeName, apiKey });
      if (fallback) return fallback;
    }
    const suffix = detail ? `: ${detail}` : "";
    throw new Error(`Groq transcription failed (${response.status})${suffix}`);
  }

  const payload = (await response.json()) as { text?: unknown };
  if (typeof payload?.text !== "string") return null;
  const trimmed = payload.text.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function shouldRetryGroqViaFfmpeg(error: Error): boolean {
  const msg = error.message.toLowerCase();
  return (
    msg.includes("unrecognized file format") ||
    msg.includes("could not be decoded") ||
    msg.includes("format is not supported")
  );
}

async function tryGroqCurlFallback({
  bytes,
  mediaType,
  safeName,
  apiKey,
}: {
  bytes: Uint8Array;
  mediaType: string;
  safeName: string;
  apiKey: string;
}): Promise<string | null> {
  const root = await mkdtemp(join(tmpdir(), "summarize-groq-curl-"));
  const inputPath = join(root, safeName);
  const outputPath = join(root, "response.json");
  try {
    await writeFile(inputPath, bytes);
    const { execFile } = await import("node:child_process");
    const timeoutSeconds = Math.max(1, Math.ceil(TRANSCRIPTION_TIMEOUT_MS / 1000));
    const stdout = await new Promise<string>((resolve, reject) =>
      execFile(
        "curl",
        [
          "-sS",
          "-o",
          outputPath,
          "-w",
          "%{http_code}",
          "-X",
          "POST",
          "-H",
          "Accept: application/json",
          "-H",
          `Authorization: Bearer ${apiKey}`,
          "-F",
          `file=@${inputPath};type=${mediaType};filename=${safeName}`,
          "-F",
          "model=whisper-large-v3-turbo",
          "--max-time",
          String(timeoutSeconds),
          GROQ_TRANSCRIPT_URL,
        ],
        { encoding: "utf8", windowsHide: true },
        (error, stdoutText) => {
          if (error) {
            reject(error);
            return;
          }
          resolve(String(stdoutText ?? ""));
        },
      ),
    );
    const statusCode = Number.parseInt(stdout.trim(), 10);
    const bodyText = await readFile(outputPath, "utf8").catch(() => "");
    if (!Number.isFinite(statusCode) || statusCode < 200 || statusCode >= 300) {
      return null;
    }
    const payload = JSON.parse(bodyText) as { text?: unknown };
    if (typeof payload?.text !== "string") return null;
    const trimmed = payload.text.trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch {
    return null;
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => {});
  }
}
