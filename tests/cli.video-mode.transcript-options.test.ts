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
});
