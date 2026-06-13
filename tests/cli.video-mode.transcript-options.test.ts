import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { describe, expect, it, vi } from "vitest";

function collectStream({ isTTY }: { isTTY: boolean }) {
  let text = "";
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      text += chunk.toString();
      callback();
    },
  });
  (stream as unknown as { isTTY?: boolean }).isTTY = isTTY;
  (stream as unknown as { columns?: number }).columns = 120;
  return { stream, getText: () => text };
}

const mocks = vi.hoisted(() => {
  const fetchLinkContent = vi.fn(async (_url: string, options?: Record<string, unknown>) => {
    return {
      url: _url,
      title: "Media",
      description: null,
      siteName: null,
      content: "Transcript: hello",
      truncated: false,
      totalCharacters: 17,
      wordCount: 2,
      transcriptCharacters: 11,
      transcriptLines: null,
      transcriptWordCount: 1,
      transcriptSource: "embedded",
      transcriptMetadata: null,
      transcriptionProvider: null,
      transcriptSegments: null,
      transcriptTimedText: null,
      mediaDurationSeconds: null,
      video: { kind: "direct", url: _url },
      isVideoOnly: true,
      diagnostics: {
        strategy: "html",
        cacheMode: "default",
        cacheStatus: "miss",
        firecrawl: { attempted: false, used: false, notes: null },
        markdown: { requested: false, used: false, provider: null, notes: null },
        transcript: {
          cacheMode: "default",
          cacheStatus: "miss",
          textProvided: true,
          provider: "embedded",
          attemptedProviders: ["embedded"],
          notes: null,
        },
      },
      __options: options ?? null,
    };
  });

  const createLinkPreviewClient = vi.fn(() => ({ fetchLinkContent }));

  return { createLinkPreviewClient, fetchLinkContent };
});

vi.mock("../src/content/index.js", () => ({
  createLinkPreviewClient: mocks.createLinkPreviewClient,
  resolveTranscriptionAvailability: vi.fn(async () => ({ hasAnyProvider: true })),
}));

import { runCli } from "../src/run.js";

describe("cli --video-mode transcript", () => {
  it("passes media transcript preference to the extractor", async () => {
    const stdout = collectStream({ isTTY: false });
    const stderr = collectStream({ isTTY: true });

    await runCli(
      ["--extract", "--metrics", "off", "--video-mode", "transcript", "https://example.com/page"],
      {
        env: {},
        fetch: vi.fn() as unknown as typeof fetch,
        stdout: stdout.stream,
        stderr: stderr.stream,
      },
    );

    const options = mocks.fetchLinkContent.mock.calls.at(-1)?.[1] as
      | Record<string, unknown>
      | undefined;
    expect(options?.mediaTranscript).toBe("prefer");
  });

  it("passes bare --diarize through as auto for YouTube extracts", async () => {
    const stdout = collectStream({ isTTY: false });
    const stderr = collectStream({ isTTY: true });

    await runCli(
      ["--extract", "--metrics", "off", "--diarize", "https://www.youtube.com/watch?v=abcdefghijk"],
      {
        env: {},
        fetch: vi.fn() as unknown as typeof fetch,
        stdout: stdout.stream,
        stderr: stderr.stream,
      },
    );

    const options = mocks.fetchLinkContent.mock.calls.at(-1)?.[1] as
      | Record<string, unknown>
      | undefined;
    expect(options?.transcriptDiarization).toBe("auto");
  });

  it("passes explicit diarization providers through to the extractor", async () => {
    const stdout = collectStream({ isTTY: false });
    const stderr = collectStream({ isTTY: true });

    await runCli(
      [
        "--extract",
        "--metrics",
        "off",
        "--diarize",
        "openai",
        "https://www.youtube.com/watch?v=abcdefghijk",
      ],
      {
        env: {},
        fetch: vi.fn() as unknown as typeof fetch,
        stdout: stdout.stream,
        stderr: stderr.stream,
      },
    );

    const options = mocks.fetchLinkContent.mock.calls.at(-1)?.[1] as
      | Record<string, unknown>
      | undefined;
    expect(options?.transcriptDiarization).toBe("openai");
  });

  it.each(["mp3", "mp4"])("diarizes a local %s through the media asset flow", async (extension) => {
    const root = mkdtempSync(join(tmpdir(), `summarize-cli-diarize-${extension}-`));
    const mediaPath = join(root, `interview.${extension}`);
    writeFileSync(mediaPath, Buffer.from([0xff, 0xfb, 0x10, 0x00]));
    const stdout = collectStream({ isTTY: false });
    const stderr = collectStream({ isTTY: true });

    try {
      await runCli(["--extract", "--metrics", "off", "--diarize", mediaPath], {
        env: {
          OPENAI_API_KEY: "test-openai",
          YT_DLP_PATH: "/usr/bin/yt-dlp",
        },
        fetch: vi.fn() as unknown as typeof fetch,
        stdout: stdout.stream,
        stderr: stderr.stream,
      });

      const clientOptions = mocks.createLinkPreviewClient.mock.calls.at(-1)?.[0] as
        | { transcription?: Record<string, unknown> }
        | undefined;
      const fetchOptions = mocks.fetchLinkContent.mock.calls.at(-1)?.[1] as
        | Record<string, unknown>
        | undefined;
      expect(clientOptions?.transcription?.openaiApiKey).toBe("test-openai");
      expect(fetchOptions).toMatchObject({
        transcriptDiarization: "auto",
        mediaTranscript: "prefer",
      });
      expect(stdout.getText()).toContain("Transcript: hello");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("forwards ElevenLabs diarization and timestamps for local media without yt-dlp", async () => {
    const root = mkdtempSync(join(tmpdir(), "summarize-cli-elevenlabs-diarize-"));
    const mediaPath = join(root, "interview.mp3");
    writeFileSync(mediaPath, Buffer.from([0xff, 0xfb, 0x10, 0x00]));
    const stdout = collectStream({ isTTY: false });
    const stderr = collectStream({ isTTY: true });

    try {
      await runCli(
        ["--extract", "--metrics", "off", "--timestamps", "--diarize", "elevenlabs", mediaPath],
        {
          env: {
            ELEVENLABS_API_KEY: "test-elevenlabs",
            PATH: "/nonexistent",
          },
          fetch: vi.fn() as unknown as typeof fetch,
          stdout: stdout.stream,
          stderr: stderr.stream,
        },
      );

      const clientOptions = mocks.createLinkPreviewClient.mock.calls.at(-1)?.[0] as
        | {
            transcription?: { elevenlabsApiKey?: string | null };
            ytDlpPath?: string | null;
          }
        | undefined;
      const fetchOptions = mocks.fetchLinkContent.mock.calls.at(-1)?.[1] as
        | Record<string, unknown>
        | undefined;
      expect(clientOptions?.transcription?.elevenlabsApiKey).toBe("test-elevenlabs");
      expect(clientOptions?.ytDlpPath).toBeNull();
      expect(fetchOptions).toMatchObject({
        mediaTranscript: "prefer",
        transcriptDiarization: "elevenlabs",
        transcriptTimestamps: true,
      });
      expect(stdout.getText()).toContain("Transcript: hello");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each(["mp3", "mp4"])(
    "diarizes a direct %s URL through the media asset flow",
    async (extension) => {
      const stdout = collectStream({ isTTY: false });
      const stderr = collectStream({ isTTY: true });
      const url = `https://cdn.example.com/interview.${extension}`;

      await runCli(["--extract", "--metrics", "off", "--diarize", "openai", url], {
        env: {
          OPENAI_API_KEY: "test-openai",
          YT_DLP_PATH: "/usr/bin/yt-dlp",
        },
        fetch: vi.fn() as unknown as typeof fetch,
        stdout: stdout.stream,
        stderr: stderr.stream,
      });

      const fetchCall = mocks.fetchLinkContent.mock.calls.at(-1);
      expect(fetchCall?.[0]).toBe(url);
      expect(fetchCall?.[1]).toMatchObject({
        transcriptDiarization: "openai",
        mediaTranscript: "prefer",
      });
      expect(stdout.getText()).toContain("Transcript: hello");
    },
  );

  it("rejects diarization for ordinary web pages", async () => {
    const stdout = collectStream({ isTTY: false });
    const stderr = collectStream({ isTTY: true });

    await expect(
      runCli(["--extract", "--metrics", "off", "--diarize", "https://example.com/article"], {
        env: {},
        fetch: vi.fn() as unknown as typeof fetch,
        stdout: stdout.stream,
        stderr: stderr.stream,
      }),
    ).rejects.toThrow("--diarize requires a YouTube URL or a direct audio/video file");
  });
});
