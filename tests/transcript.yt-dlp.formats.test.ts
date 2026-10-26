import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { acquireYtDlpMedia } from "../packages/core/src/content/transcript/providers/youtube/yt-dlp-media.js";
import { runYtDlpDownload } from "../packages/core/src/content/transcript/providers/youtube/yt-dlp-process.js";

vi.mock("../packages/core/src/content/transcript/providers/youtube/yt-dlp-process.js", () => ({
  runYtDlpDownload: vi.fn(),
}));

const ytDlpPath = process.env.YT_DLP_PATH ?? "yt-dlp";
const hasYtDlp = spawnSync(ytDlpPath, ["--version"], { timeout: 10_000 }).status === 0;

// Exercise yt-dlp's real selector against local metadata, without media downloads or API keys.
describe.skipIf(!hasYtDlp)("yt-dlp audio format selection (offline)", () => {
  it.each([
    {
      name: "accepts direct MP4 with unknown codec and resolution metadata",
      formats: [{ format_id: "direct" }],
      selected: "direct",
    },
    {
      name: "rejects known video-only media",
      formats: [{ format_id: "silent", vcodec: "avc1", acodec: "none", height: 360 }],
      selected: null,
    },
    {
      name: "skips known video-only media in favor of an unknown direct MP4",
      formats: [
        { format_id: "direct" },
        { format_id: "silent", vcodec: "avc1", acodec: "none", height: 1080 },
      ],
      selected: "direct",
    },
    {
      name: "prefers audio-only media over a combined MP4",
      formats: [
        { format_id: "audio", vcodec: "none", acodec: "aac" },
        { format_id: "combined", vcodec: "avc1", acodec: "aac", height: 1080 },
      ],
      selected: "audio",
    },
    {
      name: "preserves the preference for smaller combined videos",
      formats: [
        { format_id: "small", vcodec: "avc1", acodec: "aac", height: 360 },
        { format_id: "large", vcodec: "avc1", acodec: "aac", height: 1080 },
      ],
      selected: "small",
    },
  ])("$name", async ({ formats, selected }) => {
    const root = await mkdtemp(join(tmpdir(), "summarize-ytdlp-formats-"));
    const infoPath = join(root, "media.info.json");
    await writeFile(
      infoPath,
      JSON.stringify({
        id: "direct-mp4",
        title: "Direct MP4",
        extractor: "generic",
        extractor_key: "Generic",
        formats: formats.map((format) => ({
          ext: "mp4",
          protocol: "https",
          url: `https://example.invalid/${format.format_id}.mp4`,
          ...format,
        })),
      }),
    );
    vi.mocked(runYtDlpDownload).mockImplementation(async ({ format, output }) => {
      const selectedFormat = execFileSync(
        ytDlpPath,
        [
          "--ignore-config",
          "--no-cache-dir",
          "--simulate",
          "--load-info-json",
          infoPath,
          "-f",
          format,
          "--print",
          "%(format_id)s",
        ],
        { encoding: "utf8", timeout: 10_000, stdio: "pipe" },
      ).trim();
      await writeFile(output, selectedFormat);
    });

    try {
      const media = acquireYtDlpMedia({
        ytDlpPath,
        url: "https://example.invalid/direct.mp4",
        service: "generic",
        mediaKind: "video",
        mediaCache: null,
        downloadVideo: false,
        localFileInput: null,
      });
      if (selected === null) {
        await expect(media).rejects.toThrow("Requested format is not available");
      } else {
        const acquired = await media;
        try {
          expect(await readFile(acquired.filePath, "utf8")).toBe(selected);
        } finally {
          await acquired.cleanup();
        }
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
