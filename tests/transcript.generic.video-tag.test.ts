import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { resolveTranscriptForLink } from "../packages/core/src/content/transcript/index.js";
import { fetchTranscript } from "../packages/core/src/content/transcript/providers/generic.js";

const { fetchTranscriptWithYtDlp } = vi.hoisted(() => ({
  fetchTranscriptWithYtDlp: vi.fn(async () => ({
    text: "yt-dlp transcript",
    provider: "openai",
    notes: [],
    error: null,
    segments: [{ startMs: 0, endMs: 1000, speaker: "Speaker A", text: "Hello" }],
  })),
}));

vi.mock("../packages/core/src/content/transcript/providers/youtube/yt-dlp.js", () => ({
  fetchTranscriptWithYtDlp,
}));

const buildOptions = (overrides?: Partial<Parameters<typeof fetchTranscript>[1]>) => ({
  fetch: fetch,
  scrapeWithFirecrawl: null,
  apifyApiToken: null,
  youtubeTranscriptMode: "auto",
  mediaTranscriptMode: "auto",
  ytDlpPath: "/usr/bin/yt-dlp",
  groqApiKey: null,
  falApiKey: null,
  openaiApiKey: "test",
  resolveTwitterCookies: null,
  onProgress: null,
  ...overrides,
});

describe("generic transcript provider (video tag fallback)", () => {
  it("uses yt-dlp when mediaTranscriptMode=prefer and a video tag lacks src", async () => {
    const html = `
      <html>
        <body>
          <video class="u-full-width" preload="none" controls></video>
        </body>
      </html>
    `;

    const result = await fetchTranscript(
      { url: "https://example.com/page", html, resourceKey: null },
      buildOptions({ mediaTranscriptMode: "prefer" }),
    );

    expect(fetchTranscriptWithYtDlp).toHaveBeenCalledTimes(1);
    expect(fetchTranscriptWithYtDlp).toHaveBeenCalledWith(
      expect.objectContaining({ url: "https://example.com/page" }),
    );
    expect(result.source).toBe("yt-dlp");
    expect(result.text).toContain("yt-dlp transcript");
    expect(result.attemptedProviders).toContain("yt-dlp");
  });

  it("does not use yt-dlp without prefer mode", async () => {
    fetchTranscriptWithYtDlp.mockClear();
    const html = `
      <html>
        <body>
          <video class="u-full-width" preload="none" controls></video>
        </body>
      </html>
    `;

    const result = await fetchTranscript(
      { url: "https://example.com/page", html, resourceKey: null },
      buildOptions({ mediaTranscriptMode: "auto" }),
    );

    expect(fetchTranscriptWithYtDlp).not.toHaveBeenCalled();
    expect(result.source).toBeNull();
  });

  it("passes inferred video kind for direct media URLs", async () => {
    fetchTranscriptWithYtDlp.mockClear();

    await fetchTranscript(
      { url: "file:///tmp/local-video.webm", html: null, resourceKey: null },
      buildOptions({ mediaTranscriptMode: "prefer" }),
    );

    expect(fetchTranscriptWithYtDlp).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "file:///tmp/local-video.webm",
        mediaKind: "video",
      }),
    );
  });

  it("passes diarization through and preserves speaker metadata and segments", async () => {
    fetchTranscriptWithYtDlp.mockClear();

    const result = await fetchTranscript(
      { url: "https://cdn.example.com/interview.mp4", html: null, resourceKey: null },
      buildOptions({
        mediaTranscriptMode: "prefer",
        transcriptDiarization: "openai",
      }),
    );

    expect(fetchTranscriptWithYtDlp).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://cdn.example.com/interview.mp4",
        diarization: "openai",
      }),
    );
    expect(result.segments).toEqual([
      { startMs: 0, endMs: 1000, speaker: "Speaker A", text: "Hello" },
    ]);
    expect(result.metadata).toMatchObject({
      speakerLabels: true,
      diarizationProvider: "openai",
      transcriptionProvider: "openai",
    });
  });

  it("allows local direct media transcription without yt-dlp", async () => {
    fetchTranscriptWithYtDlp.mockClear();
    const root = mkdtempSync(join(tmpdir(), "summarize-generic-local-media-"));
    const audioPath = join(root, "recording.mp3");
    writeFileSync(audioPath, Buffer.from([0xff, 0xfb, 0x10, 0x00]));
    const url = pathToFileURL(audioPath).href;

    try {
      const result = await fetchTranscript(
        { url, html: null, resourceKey: null },
        buildOptions({
          ytDlpPath: null,
          mediaTranscriptMode: "prefer",
          transcriptDiarization: "openai",
        }),
      );

      expect(fetchTranscriptWithYtDlp).toHaveBeenCalledWith(
        expect.objectContaining({
          ytDlpPath: null,
          url,
          diarization: "openai",
        }),
      );
      expect(result.text).toBe("yt-dlp transcript");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("routes Loom through yt-dlp in auto mode using the original recording URL", async () => {
    fetchTranscriptWithYtDlp.mockClear();
    const loomUrl = "https://www.loom.com/share/ef3224a48a084371bd6d766ee81f083f";

    const result = await fetchTranscript(
      {
        url: loomUrl,
        html: '<video src="https://cdn.example.com/video-only.mp4"></video>',
        resourceKey: null,
      },
      buildOptions({ mediaTranscriptMode: "auto" }),
    );

    expect(fetchTranscriptWithYtDlp).toHaveBeenCalledWith(
      expect.objectContaining({
        url: loomUrl,
        service: "generic",
        mediaKind: "video",
      }),
    );
    expect(result).toMatchObject({
      source: "yt-dlp",
      text: "yt-dlp transcript",
      metadata: { provider: "generic", kind: "video", transcriptionProvider: "openai" },
    });
  });

  it("preserves Loom identity when HTML contains an incidental YouTube embed", async () => {
    fetchTranscriptWithYtDlp.mockClear();
    const loomUrl = "https://www.loom.com/share/ef3224a48a084371bd6d766ee81f083f";

    await resolveTranscriptForLink(
      loomUrl,
      '<iframe src="https://www.youtube.com/embed/dQw4w9WgXcQ"></iframe>',
      {
        fetch,
        scrapeWithFirecrawl: null,
        apifyApiToken: null,
        ytDlpPath: "/usr/bin/yt-dlp",
        groqApiKey: null,
        falApiKey: null,
        openaiApiKey: "test",
        transcriptCache: null,
        resolveTwitterCookies: null,
        onProgress: null,
      },
      { mediaTranscriptMode: "auto" },
    );

    expect(fetchTranscriptWithYtDlp).toHaveBeenCalledWith(
      expect.objectContaining({ url: loomUrl, service: "generic", mediaKind: "video" }),
    );
  });
});
