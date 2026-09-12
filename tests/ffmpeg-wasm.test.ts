import { mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveBundledFfmpegCommand } from "../packages/core/src/ffmpeg.js";
import {
  runFfmpegTranscodeToMp3,
  runFfmpegTranscodeToMp3Lenient,
  runFfmpegTranscodeToWav,
} from "../packages/core/src/transcription/whisper/ffmpeg.js";
import { runProcess, runProcessCapture } from "../src/slides/process.js";

const fixture = resolve(
  import.meta.dirname,
  "..",
  "apps",
  "chrome-extension",
  "tests",
  "fixtures",
  "ffmpeg-wasm-sample.mp4",
);

describe("bundled ffmpeg wasm", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("can be disabled explicitly", () => {
    vi.stubEnv("SUMMARIZE_DISABLE_FFMPEG_WASM", "1");
    expect(resolveBundledFfmpegCommand("ffmpeg")).toBeNull();
  });

  it("probes media without a native ffprobe command", async () => {
    const command = resolveBundledFfmpegCommand("ffprobe");
    expect(command).not.toBeNull();
    const output = await runProcessCapture({
      command: command!,
      args: [
        "-v",
        "error",
        "-show_entries",
        "format=duration",
        "-of",
        "default=noprint_wrappers=1:nokey=1",
        fixture,
      ],
      timeoutMs: 60_000,
      errorLabel: "ffprobe-wasm",
    });
    expect(Number(output.trim())).toBeCloseTo(6, 1);
  }, 60_000);

  it("extracts a frame without a native ffmpeg command", async () => {
    const command = resolveBundledFfmpegCommand("ffmpeg");
    expect(command).not.toBeNull();
    const outputDir = await mkdtemp(join(tmpdir(), "summarize-ffmpeg-wasm-"));
    const outputPath = join(outputDir, "frame.png");
    await runProcess({
      command: command!,
      args: [
        "-hide_banner",
        "-loglevel",
        "error",
        "-ss",
        "1",
        "-i",
        fixture,
        "-frames:v",
        "1",
        outputPath,
      ],
      timeoutMs: 60_000,
      errorLabel: "ffmpeg-wasm",
    });
    expect((await stat(outputPath)).size).toBeGreaterThan(0);
  }, 60_000);

  it.each(["mp3", "wav", "lenient"] as const)(
    "extracts %s audio without a native ffmpeg command",
    async (format) => {
      const outputDir = await mkdtemp(join(tmpdir(), "summarize-ffmpeg-wasm-audio-"));
      const outputPath = join(outputDir, format === "wav" ? "audio.wav" : "audio.mp3");
      vi.stubEnv("PATH", outputDir);
      const transcode =
        format === "wav"
          ? runFfmpegTranscodeToWav
          : format === "lenient"
            ? runFfmpegTranscodeToMp3Lenient
            : runFfmpegTranscodeToMp3;
      const options = {
        inputPath: fixture,
        outputPath,
        bitrateKbps: 24,
      };
      await transcode(options);
      const output = await stat(outputPath);
      expect(output.size).toBeGreaterThan(0);
      if (format !== "wav") expect(output.size).toBeLessThan((await stat(fixture)).size);
    },
    60_000,
  );
});
