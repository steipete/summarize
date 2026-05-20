import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import {
  resolveUrlFetchOptions,
  shouldPreferTranscriptForTarget,
} from "../src/run/flows/url/fetch-options.js";

const baseFlags = {
  timeoutMs: 1_000,
  maxExtractCharacters: null,
  youtubeMode: "auto" as const,
  videoMode: "auto" as const,
  transcriptTimestamps: false,
  firecrawlMode: "off" as const,
  slides: null,
};

const markdown = {
  effectiveMarkdownMode: "off" as const,
  markdownRequested: false,
};

describe("url fetch options", () => {
  it("prefers transcript mode for direct slide videos", () => {
    expect(
      shouldPreferTranscriptForTarget({
        targetUrl: "https://cdn.example.com/talk.webm",
        videoMode: "auto",
        slides: { enabled: true },
      }),
    ).toBe(true);
    expect(
      shouldPreferTranscriptForTarget({
        targetUrl: "https://cdn.example.com/audio.mp3",
        videoMode: "auto",
        slides: { enabled: true },
      }),
    ).toBe(false);
  });

  it("forwards local file mtime through resolved options", async () => {
    const filePath = path.join(tmpdir(), `summarize-fetch-options-${Date.now().toString()}.webm`);
    await fs.writeFile(filePath, "video");

    try {
      const result = resolveUrlFetchOptions({
        targetUrl: pathToFileURL(filePath).href,
        flags: {
          ...baseFlags,
          slides: { enabled: true },
        },
        markdown,
        cacheMode: "default",
      });

      expect(result.localFile).toBe(true);
      expect(result.options.mediaTranscript).toBe("prefer");
      expect(result.options.fileMtime).toBeGreaterThan(0);
    } finally {
      await fs.rm(filePath, { force: true });
    }
  });

  it("leaves asset-like HTML errors off unless the CLI runner opts in", () => {
    const defaultResult = resolveUrlFetchOptions({
      targetUrl: "https://example.com/download",
      flags: baseFlags,
      markdown,
      cacheMode: "default",
    });
    const cliResult = resolveUrlFetchOptions({
      targetUrl: "https://example.com/download",
      flags: { ...baseFlags, throwOnAssetLikeHtmlError: true },
      markdown,
      cacheMode: "default",
    });

    expect(defaultResult.options.throwOnAssetLikeHtmlError).toBe(false);
    expect(cliResult.options.throwOnAssetLikeHtmlError).toBe(true);
  });
});
