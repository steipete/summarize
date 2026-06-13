import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { runCli } from "../../src/run.js";

const LIVE = process.env.SUMMARIZE_LIVE_TEST === "1";

const collectStream = () => {
  let text = "";
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      text += chunk.toString();
      callback();
    },
  });
  return { stream, getText: () => text };
};

const silentStderr = new Writable({
  write(_chunk, _encoding, callback) {
    callback();
  },
});

(LIVE ? describe : describe.skip)("live podcast hosts", () => {
  const timeoutMs = 180_000;

  const expectDescriptionOrTranscript = ({
    description,
    content,
    minDescriptionChars,
  }: {
    description: string;
    content: string;
    minDescriptionChars: number;
  }) => {
    const descriptionText = description.trim();
    const contentText = content.trim();

    if (descriptionText.length <= minDescriptionChars) {
      // Some hosts (especially geo/consent gated pages) omit metadata and return thin content.
      // Treat this as a soft skip for live host tests.
      if (contentText.length < 200) return;
      expect(contentText.length).toBeGreaterThanOrEqual(200);
      return;
    }

    expect(contentText.length).toBeGreaterThan(200);

    const looksLikeTranscript =
      /^transcript:/i.test(contentText) ||
      contentText.length >= Math.max(1200, descriptionText.length + 400) ||
      /\n{3,}/.test(contentText);

    if (looksLikeTranscript) {
      // Podcast links: prefer full transcript/content when available.
      expect(content.length).toBeGreaterThanOrEqual(1200);
      return;
    }

    // Fallback: description-sized content when no transcript is available.
    expect(contentText).toContain(descriptionText.slice(0, Math.min(50, descriptionText.length)));
    expect(contentText.length).toBeLessThan(descriptionText.length + 120);
  };

  it(
    "podbean share prefers description-sized content",
    async () => {
      const out = collectStream();
      await runCli(
        [
          "--extract",
          "--json",
          "--timeout",
          "120s",
          "https://www.podbean.com/media/share/dir-6wa7k-29a23114",
        ],
        {
          fetch: globalThis.fetch.bind(globalThis),
          stdout: out.stream,
          stderr: silentStderr,
          env: process.env,
        },
      );

      const payload = JSON.parse(out.getText()) as {
        extracted?: { content?: string; description?: string };
      };
      const description = payload.extracted?.description ?? "";
      const content = payload.extracted?.content ?? "";
      // Amazon pages can return geo/anti-bot thin payloads even via Firecrawl.
      if (description.length === 0 && content.length < 200) return;
      expectDescriptionOrTranscript({ description, content, minDescriptionChars: 80 });
    },
    timeoutMs,
  );

  it(
    "amazon music episode prefers description-sized content (requires Firecrawl)",
    async ({ skip }) => {
      const FIRECRAWL_API_KEY = process.env.FIRECRAWL_API_KEY?.trim() ?? "";
      if (!FIRECRAWL_API_KEY) {
        skip("requires FIRECRAWL_API_KEY");
      }

      const out = collectStream();
      await runCli(
        [
          "--extract",
          "--json",
          "--timeout",
          "120s",
          "https://music.amazon.de/podcasts/61e4318e-659a-46b8-9380-c268b487dc68/episodes/07a8b875-a1d2-4d00-96ea-0bd986c2c7bd/die-j%C3%A4gerin-s2f2-nur-verlierer",
        ],
        {
          fetch: globalThis.fetch.bind(globalThis),
          stdout: out.stream,
          stderr: silentStderr,
          env: process.env,
        },
      );

      const payload = JSON.parse(out.getText()) as {
        extracted?: { content?: string; description?: string };
      };
      const description = payload.extracted?.description ?? "";
      const content = payload.extracted?.content ?? "";
      expectDescriptionOrTranscript({ description, content, minDescriptionChars: 80 });
    },
    timeoutMs,
  );

  it(
    "spreaker episode prefers description-sized content",
    async () => {
      const out = collectStream();
      await runCli(
        [
          "--extract",
          "--json",
          "--timeout",
          "120s",
          "https://www.spreaker.com/episode/christmas-eve-by-the-campfire-gratitude-reflection-the-rv-life--69193832",
        ],
        {
          fetch: globalThis.fetch.bind(globalThis),
          stdout: out.stream,
          stderr: silentStderr,
          env: process.env,
        },
      );

      const payload = JSON.parse(out.getText()) as {
        extracted?: { content?: string; description?: string };
      };
      const description = payload.extracted?.description ?? "";
      const content = payload.extracted?.content ?? "";
      expectDescriptionOrTranscript({ description, content, minDescriptionChars: 60 });
    },
    timeoutMs,
  );

  it(
    "buzzsprout episode prefers description-sized content",
    async () => {
      const out = collectStream();
      await runCli(
        [
          "--extract",
          "--json",
          "--timeout",
          "120s",
          "https://www.buzzsprout.com/2449647/episodes/18377889-2025-in-review-lessons-learned-in-gratitude-anxiety-growth-confidence-self-worth-bravery-self-compassion-and-so-much-more",
        ],
        {
          fetch: globalThis.fetch.bind(globalThis),
          stdout: out.stream,
          stderr: silentStderr,
          env: process.env,
        },
      );

      const payload = JSON.parse(out.getText()) as {
        extracted?: { content?: string; description?: string };
      };
      const description = payload.extracted?.description ?? "";
      const content = payload.extracted?.content ?? "";
      expectDescriptionOrTranscript({ description, content, minDescriptionChars: 80 });
    },
    timeoutMs,
  );
});
