import { describe, expect, it } from "vitest";
import { createLinkPreviewClient } from "../src/content/index.js";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY ?? null;
const LIVE =
  process.env.SUMMARIZE_LIVE_TESTS === "1" && process.env.SUMMARIZE_LIVE_HEAVY_PODCASTS === "1";

describe("live Apple Podcasts episode transcript (RSS transcript preferred)", () => {
  const run = LIVE ? it : it.skip;

  run(
    "transcribes an Apple Podcasts episode URL",
    async () => {
      const url =
        "https://podcasts.apple.com/us/podcast/reengineering-europe-ki-werte-und-die-zukunft-europas/id1794526548?i=1000741457032";

      const client = createLinkPreviewClient({
        openaiApiKey: OPENAI_API_KEY,
      });
      const result = await client.fetchLinkContent(url, {
        timeoutMs: 300_000,
        cacheMode: "bypass",
      });

      expect(["podcastTranscript", "whisper"]).toContain(result.transcriptSource);
      expect(result.transcriptCharacters ?? 0).toBeGreaterThan(20);
      expect(result.content.toLowerCase()).toContain("transcript:");
    },
    600_000,
  );
});
