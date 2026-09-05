import { existsSync, promises as fs } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProcessHandle } from "../src/processes.js";
import { downloadRemoteVideo, downloadYoutubeVideo } from "../src/slides/download.js";
import { runProcess } from "../src/slides/process.js";

vi.mock("../src/slides/process.js", () => ({ runProcess: vi.fn(), runProcessCapture: vi.fn() }));

const youtubeOptions = {
  ytDlpPath: "yt-dlp",
  url: "https://youtube.com/watch?v=test",
  timeoutMs: 1_000,
  format: "bestvideo",
};
const outputDirectory = (args: string[]) => dirname(args[args.indexOf("-o") + 1]);

describe("slides download", () => {
  afterEach(() => {
    vi.mocked(runProcess).mockReset();
    vi.restoreAllMocks();
  });

  it.each([
    ["stdout", "progress:512|1024|NA", 50, "(512B/1KB)"],
    ["stderr", "progress:128|NA|256", 50, "(128B/256B)"],
    ["stderr", "[download] 25.0% of 1MiB at 100KiB/s ETA 00:04", 25, "at 100KiB/s ETA 00:04"],
    ["stderr", "[download] 100%", 100, undefined],
    ["stdout", "[download] 25%", null, undefined],
    ["stdout", "progress:-1|10|10", null, undefined],
    ["stderr", "progress:1|0|0", null, undefined],
  ] as const)("handles %s progress %s", async (stream, line, percent, detail) => {
    const onProgress = vi.fn();
    const setProgress = vi.fn();
    vi.mocked(runProcess).mockImplementationOnce(async (options) => {
      await writeFile(join(outputDirectory(options.args), "video.mp4"), "video");
      const handler = stream === "stdout" ? options.onStdoutLine : options.onStderrLine;
      handler?.(line, { setProgress } as unknown as ProcessHandle);
    });
    const result = await downloadYoutubeVideo({ ...youtubeOptions, onProgress });
    try {
      if (percent === null) {
        expect(onProgress).not.toHaveBeenCalled();
        expect(setProgress).not.toHaveBeenCalled();
      } else {
        expect(onProgress).toHaveBeenCalledExactlyOnceWith(percent, detail);
        expect(setProgress).toHaveBeenCalledExactlyOnceWith(percent, detail ?? null);
      }
      expect(existsSync(result.filePath)).toBe(true);
    } finally {
      await result.cleanup();
    }
  });

  it.each(["download", "inspection"])(
    "removes partial downloads after %s failure",
    async (stage) => {
      let directory = "";
      const failure = new Error("synthetic failure");
      vi.mocked(runProcess).mockImplementationOnce(async ({ args }) => {
        directory = outputDirectory(args);
        await writeFile(join(directory, "video.mp4.part"), "partial");
        if (stage === "download") throw failure;
        vi.spyOn(fs, "readdir").mockRejectedValueOnce(failure);
      });
      try {
        await expect(downloadYoutubeVideo(youtubeOptions)).rejects.toBe(failure);
        expect(existsSync(directory)).toBe(false);
      } finally {
        if (directory) await rm(directory, { recursive: true, force: true });
      }
    },
  );
  it("uses the injected fetch implementation for remote videos", async () => {
    const fetchImpl = vi.fn(async () => {
      return new Response(new Uint8Array([1, 2, 3]), {
        headers: { "content-length": "3" },
      });
    });

    const result = await downloadRemoteVideo({
      url: "https://cdn.example/video.mp4",
      timeoutMs: 1000,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    try {
      expect(fetchImpl).toHaveBeenCalledWith(
        "https://cdn.example/video.mp4",
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
      await expect(readFile(result.filePath)).resolves.toEqual(Buffer.from([1, 2, 3]));
    } finally {
      await result.cleanup();
      expect(existsSync(result.filePath)).toBe(false);
      await rm(result.filePath, { force: true });
    }
  });
});
