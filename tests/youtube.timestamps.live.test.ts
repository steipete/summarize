import { describe, expect, it } from "vitest";
import { runCli } from "../src/run.js";
import { captureStream as collectStream } from "./helpers/streams.js";

const LIVE = process.env.SUMMARIZE_LIVE_TESTS === "1" && Boolean(process.env.OPENAI_API_KEY);
const URL = "https://www.youtube.com/watch?v=9pUWFJgBc5Q";

function parseKeyMomentSeconds(summary: string): number[] {
  const lines = summary.split("\n");
  const seconds: number[] = [];
  let inKeyMoments = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (/^(?:#{1,6}\s*)?key moments:?$/i.test(trimmed)) {
      inKeyMoments = true;
      continue;
    }
    if (inKeyMoments && /^#{1,6}\s+\S/.test(trimmed)) break;
    if (!inKeyMoments) continue;
    const match = trimmed.match(
      /^(?:[-*+]\s+)?(?:\[(\d{1,2}:\d{2}(?::\d{2})?)\]|(\d{1,2}:\d{2}(?::\d{2})?))(?=\s|[-:–—])/,
    );
    const raw = match?.[1] ?? match?.[2] ?? null;
    if (!raw) continue;
    const parts = raw.split(":").map(Number);
    const value =
      parts.length === 2
        ? parts[0] * 60 + parts[1]
        : parts.length === 3
          ? parts[0] * 3600 + parts[1] * 60 + parts[2]
          : null;
    if (value != null) seconds.push(value);
  }
  return seconds;
}

describe("live YouTube summary timestamps", () => {
  const run = LIVE ? it : it.skip;

  run(
    "does not emit impossible key moments for the Babylon 5 video",
    async () => {
      const stdout = collectStream();
      const stderr = collectStream();

      await runCli(
        [
          "--json",
          "--no-cache",
          "--timestamps",
          "--model",
          "openai/gpt-5.2",
          "--timeout",
          "120s",
          URL,
        ],
        {
          env: process.env,
          stdout: stdout.stream,
          stderr: stderr.stream,
          fetch: globalThis.fetch.bind(globalThis),
        },
      );

      const payload = JSON.parse(stdout.getText()) as {
        extracted: { mediaDurationSeconds: number | null };
        summary: string;
      };
      const maxSeconds = payload.extracted.mediaDurationSeconds ?? 0;
      const keyMomentSeconds = parseKeyMomentSeconds(payload.summary);

      expect(maxSeconds).toBeGreaterThan(0);
      expect(keyMomentSeconds.length).toBeGreaterThan(0);
      expect(Math.max(...keyMomentSeconds)).toBeLessThanOrEqual(maxSeconds);
      expect(payload.summary).not.toMatch(/\b(?:27:55|30:55|33:10)\b/);
      expect(stderr.getText()).toContain("19m 33s YouTube");
    },
    180_000,
  );
});
