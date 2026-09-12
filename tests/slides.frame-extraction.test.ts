import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { extractFramesAtTimestamps } from "../src/slides/frame-extraction.js";
import { runProcess } from "../src/slides/process.js";

vi.mock("../src/slides/process.js", () => ({
  runProcess: vi.fn(),
  runWithConcurrency: async (tasks: Array<() => Promise<unknown>>) =>
    Promise.all(tasks.map((task) => task())),
}));

describe("slide frame timestamp ownership", () => {
  it("collects metadata only after trimming to the requested frame", async () => {
    const directory = await fs.mkdtemp(path.join(tmpdir(), "summarize-frame-timestamps-"));
    vi.mocked(runProcess).mockImplementation(async ({ args, onStderrLine }) => {
      const filter = args[args.indexOf("-vf") + 1];
      const trimStart = Number(filter.match(/trim=start=([\d.]+)/)?.[1] ?? 0);
      onStderrLine?.(`[Parsed_showinfo] pts_time:${trimStart}`, null);
      for (const line of [
        "lavfi.signalstats.YMIN=16",
        "lavfi.signalstats.YMAX=235",
        "lavfi.signalstats.YAVG=180",
      ])
        onStderrLine?.(line, null);
      await fs.writeFile(args.at(-1)!, "synthetic frame");
    });
    try {
      const timestamps = [0.32, 4.32, 8.32];
      const slides = await extractFramesAtTimestamps({
        ffmpegPath: "ffmpeg",
        inputPath: "fixture.mp4",
        outputDir: directory,
        timestamps,
        durationSeconds: 12,
        timeoutMs: 1000,
        workers: 1,
      });
      expect(slides).toHaveLength(3);
      slides.forEach((slide, index) => expect(slide.timestamp).toBeCloseTo(timestamps[index], 4));
      for (const [{ args }] of vi.mocked(runProcess).mock.calls) {
        expect(args[args.indexOf("-vf") + 1]).toMatch(/^trim=start=[\d.]+,signalstats,showinfo,/);
        expect(args.slice(args.indexOf("-i") + 2)).not.toContain("-ss");
      }
    } finally {
      vi.mocked(runProcess).mockReset();
      await fs.rm(directory, { recursive: true, force: true });
    }
  });
});
