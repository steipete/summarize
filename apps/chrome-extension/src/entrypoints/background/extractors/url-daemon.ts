import type { Extractor, ExtractorContext, ExtractorResult } from "./types";

type UrlDaemonExtractResponse = {
  ok?: boolean;
  extracted?: {
    content?: string;
    title?: string | null;
    url?: string;
    wordCount?: number;
    totalCharacters?: number;
    truncated?: boolean;
    transcriptSource?: string | null;
    transcriptCharacters?: number | null;
    transcriptWordCount?: number | null;
    transcriptLines?: number | null;
    transcriptionProvider?: string | null;
    transcriptTimedText?: string | null;
    mediaDurationSeconds?: number | null;
    diagnostics?: ExtractorResult["diagnostics"];
  };
  error?: string;
};

export const urlDaemonExtractor: Extractor = {
  name: "url-daemon",
  match: () => true,
  async extract(ctx: ExtractorContext): Promise<ExtractorResult | null> {
    const res = await ctx.fetchImpl("http://127.0.0.1:8787/v1/summarize", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ctx.token.trim()}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        url: ctx.url,
        title: ctx.title,
        mode: "url",
        extractOnly: true,
        ...(ctx.noCache ? { noCache: true } : {}),
        maxCharacters: ctx.maxChars,
        diagnostics: ctx.includeDiagnostics ? { includeContent: true } : null,
      }),
      signal: ctx.signal,
    });
    const json = (await res.json()) as UrlDaemonExtractResponse;
    if (!res.ok || !json.ok || !json.extracted) return null;

    const text = json.extracted.content?.trim() ?? "";
    if (text.length < ctx.minTextChars) return null;

    return {
      source: "url",
      diagnostics: json.extracted.diagnostics ?? null,
      extracted: {
        ok: true,
        url: json.extracted.url || ctx.url,
        title: json.extracted.title ?? ctx.title,
        text,
        truncated: Boolean(json.extracted.truncated),
        mediaDurationSeconds: json.extracted.mediaDurationSeconds ?? null,
        media: null,
      },
    };
  },
};
