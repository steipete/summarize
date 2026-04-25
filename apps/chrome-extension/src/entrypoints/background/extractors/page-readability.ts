import type { Extractor, ExtractorContext, ExtractorResult } from "./types";

export const pageReadabilityExtractor: Extractor = {
  name: "page-readability",
  match: () => true,
  async extract(ctx: ExtractorContext): Promise<ExtractorResult | null> {
    const attempt = await ctx.extractFromTab(ctx.tabId, ctx.maxChars, {
      timeoutMs: 8_000,
      log: ctx.log,
    });
    if (!attempt.ok) return null;

    const text = attempt.data.text.trim();
    if (text.length < ctx.minTextChars) return null;

    return {
      source: "page",
      extracted: attempt.data,
    };
  },
};
