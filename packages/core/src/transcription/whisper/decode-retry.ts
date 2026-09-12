import { isFfmpegAvailable, transcodeBytesToMp3 } from "./ffmpeg.js";
import type { ProviderResult, TranscriptionBytes } from "./request.js";
import { wrapError } from "./utils.js";

export async function transcribeWithDecodeRetry({
  source,
  provider,
  notes,
  transcribe,
  shouldRetry,
}: {
  source: TranscriptionBytes;
  provider: "groq" | "openai";
  notes: string[];
  transcribe: (source: TranscriptionBytes) => Promise<string | null>;
  shouldRetry: (error: Error) => boolean;
}): Promise<ProviderResult & { source: TranscriptionBytes }> {
  const label = provider === "groq" ? "Groq" : "OpenAI";
  const success = (
    text: string,
    input = source,
  ): ProviderResult & { source: TranscriptionBytes } => ({
    kind: "result",
    source: input,
    result: { text, provider, error: null, notes: [] },
  });
  let failure: Error;
  try {
    const text = await transcribe(source);
    if (text) return success(text);
    failure = new Error(`${label} transcription returned empty text`);
  } catch (error) {
    failure = wrapError(`${label} transcription failed`, error);
  }
  if (shouldRetry(failure)) {
    if (await isFfmpegAvailable()) {
      try {
        notes.push(`${label} could not decode media; transcoding via ffmpeg and retrying`);
        const converted: TranscriptionBytes = {
          kind: "bytes",
          bytes: await transcodeBytesToMp3(source.bytes),
          mediaType: "audio/mpeg",
          filename: "audio.mp3",
        };
        const text = await transcribe(converted);
        if (text) return success(text, converted);
        failure = new Error(`${label} transcription returned empty text after ffmpeg transcode`);
        source = converted;
      } catch (error) {
        notes.push(
          `ffmpeg transcode failed; cannot retry ${label} decode error: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    } else {
      notes.push(`${label} could not decode media; install ffmpeg to enable transcoding retry`);
    }
  }
  return { kind: "error", error: failure, source };
}
