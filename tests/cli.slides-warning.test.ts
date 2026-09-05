import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { runCli } from "../src/run.js";
import { captureStream as collectStream } from "./helpers/streams.js";

const mocks = vi.hoisted(() => {
  const extracted = {
    content: "Hello from the article body.",
    title: "Test video",
    description: null,
    url: "https://www.youtube.com/watch?v=abc123def45",
    siteName: "YouTube",
    wordCount: 5,
    totalCharacters: 28,
    truncated: false,
    mediaDurationSeconds: null,
    video: null,
    isVideoOnly: false,
    transcriptSource: null,
    transcriptCharacters: null,
    transcriptWordCount: null,
    transcriptLines: null,
    transcriptMetadata: null,
    transcriptSegments: null,
    transcriptTimedText: null,
    transcriptionProvider: null,
    diagnostics: {
      strategy: "html",
      firecrawl: {
        attempted: false,
        used: false,
        cacheMode: "bypassed",
        cacheStatus: "bypassed",
        notes: null,
      },
      markdown: {
        requested: false,
        used: false,
        provider: null,
        notes: null,
      },
      transcript: {
        cacheMode: "bypassed",
        cacheStatus: "bypassed",
        textProvided: false,
        provider: null,
        attemptedProviders: [],
        notes: null,
      },
    },
  };

  return {
    extracted,
    fetchLinkContentWithBirdTip: vi.fn(async () => extracted),
    extractSlidesForSource: vi.fn(async () => {
      throw new Error("Missing ffmpeg (install ffmpeg or add it to PATH).");
    }),
  };
});

vi.mock("../src/run/flows/url/extract.js", async () => {
  const actual = await vi.importActual<typeof import("../src/run/flows/url/extract.js")>(
    "../src/run/flows/url/extract.js",
  );
  return {
    ...actual,
    fetchLinkContentWithBirdTip: mocks.fetchLinkContentWithBirdTip,
  };
});

vi.mock("../src/slides/index.js", async () => {
  const actual =
    await vi.importActual<typeof import("../src/slides/index.js")>("../src/slides/index.js");
  return {
    ...actual,
    extractSlidesForSource: mocks.extractSlidesForSource,
  };
});

describe("--slides dependency warning", () => {
  it("warns when slide extraction dependencies are missing in summary mode", async () => {
    const root = mkdtempSync(join(tmpdir(), "summarize-slides-warning-"));
    const stdout = collectStream();
    const stderr = collectStream();

    await runCli([mocks.extracted.url, "--plain", "--timeout", "2s", "--slides"], {
      env: { HOME: root },
      fetch: globalThis.fetch.bind(globalThis),
      stdout: stdout.stream,
      stderr: stderr.stream,
    });

    expect(stderr.getText()).toContain(
      "--slides could not extract slide images: Missing ffmpeg (install ffmpeg or add it to PATH).",
    );
    expect(stderr.getText()).toContain(
      "Install ffmpeg + yt-dlp for --slides, and tesseract for --slides-ocr.",
    );
    expect(stdout.getText()).toContain("Hello from the article body.");
  });
});
