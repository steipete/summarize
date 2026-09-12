import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runCli } from "../src/run.js";
import { captureStream as collectStream } from "./helpers/streams.js";

vi.mock("../packages/core/src/transcription/whisper/ffmpeg.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../packages/core/src/transcription/whisper/ffmpeg.js")>();
  return {
    ...actual,
    probeMediaDurationSecondsWithFfprobe: vi.fn(async () => 2),
  };
});

describe("CLI media diarization integration", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each([
    { extension: "mp3", timestamps: false, identifySpeakers: false },
    { extension: "mp4", timestamps: true, identifySpeakers: true },
  ])(
    "diarizes a local $extension file without yt-dlp",
    async ({ extension, timestamps, identifySpeakers }) => {
      const root = mkdtempSync(join(tmpdir(), `summarize-diarize-e2e-${extension}-`));
      const mediaPath = join(root, `interview.${extension}`);
      if (extension === "mp4") {
        copyFileSync(
          fileURLToPath(
            new URL(
              "../apps/chrome-extension/tests/fixtures/ffmpeg-wasm-sample.mp4",
              import.meta.url,
            ),
          ),
          mediaPath,
        );
      } else {
        writeFileSync(mediaPath, Buffer.from([0x49, 0x44, 0x33]));
      }
      const stdout = collectStream();
      const stderr = collectStream();
      const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString();
        expect(url).toBe("https://api.openai.com/v1/audio/transcriptions");
        const form = init?.body as FormData;
        expect(form.get("model")).toBe("gpt-4o-transcribe-diarize");
        expect(form.get("response_format")).toBe("diarized_json");
        expect(form.get("chunking_strategy")).toBe("auto");
        const file = form.get("file") as File;
        expect(file.name).toBe(extension === "mp4" ? "audio.mp3" : "interview.mp3");
        expect(file.type).toBe("audio/mpeg");
        if (extension === "mp4") {
          expect(file.size).toBeLessThan(readFileSync(mediaPath).byteLength);
        }
        return new Response(
          JSON.stringify({
            segments: [
              { start: 0, end: 1, speaker: "A", text: "Welcome." },
              { start: 1.25, end: 2, speaker: "B", text: "Thanks." },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      });
      vi.stubGlobal("fetch", fetchMock);

      try {
        await runCli(
          [
            "--extract",
            "--metrics",
            "off",
            "--diarize",
            "openai",
            ...(timestamps ? ["--timestamps"] : []),
            ...(identifySpeakers
              ? [
                  "--identify-speakers",
                  "--speaker-at",
                  "0:00=Alice",
                  "--speaker-at",
                  "0:01.25=Bob",
                  "--speaker-profile",
                  "local-interview",
                  "--remember-speakers",
                ]
              : []),
            mediaPath,
          ],
          {
            env: {
              HOME: root,
              OPENAI_API_KEY: "test-openai",
              PATH: "/nonexistent",
            },
            fetch: fetchMock as typeof fetch,
            stdout: stdout.stream,
            stderr: stderr.stream,
          },
        );

        expect(fetchMock).toHaveBeenCalledTimes(1);
        if (identifySpeakers) {
          expect(stdout.getText()).toContain("[0:00] Alice: Welcome.");
          expect(stdout.getText()).toContain("[0:01] Bob: Thanks.");
          const config = JSON.parse(
            readFileSync(join(root, ".summarize", "config.json"), "utf8"),
          ) as {
            speakers?: {
              profiles?: Record<string, unknown>;
              sources?: Record<string, { profile?: string; mappings?: Record<string, string> }>;
            };
          };
          expect(config.speakers?.profiles?.["local-interview"]).toBeDefined();
          expect(config.speakers?.sources?.[mediaPath]).toMatchObject({
            profile: "local-interview",
            mappings: {
              "Speaker A": "Alice",
              "Speaker B": "Bob",
            },
          });
        } else {
          expect(stdout.getText()).toContain("Speaker A: Welcome.");
          expect(stdout.getText()).toContain("Speaker B: Thanks.");
        }
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
});
