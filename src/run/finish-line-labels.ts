import type { FinishLabel } from "./finish-line-types.js";

export type ExtractDiagnosticsForFinishLine = {
  strategy: "bird" | "xurl" | "twitter-syndication" | "nitter" | "firecrawl" | "html";
  firecrawl: { used: boolean };
  markdown: { used: boolean; provider: "firecrawl" | "llm" | null; notes?: string | null };
  transcript: { textProvided: boolean; provider: string | null };
};

export function buildExtractFinishLabel(args: {
  extracted: { diagnostics: ExtractDiagnosticsForFinishLine };
  format: "text" | "markdown";
  markdownMode: "off" | "auto" | "llm" | "readability";
  hasMarkdownLlmCall: boolean;
}): FinishLabel {
  const finish = (via: string | null = null): FinishLabel => ({
    kind: "extract",
    format: args.format,
    via,
  });

  const transcriptProvided = Boolean(args.extracted.diagnostics.transcript?.textProvided);
  if (transcriptProvided) {
    const provider = args.extracted.diagnostics.transcript?.provider;
    return finish(provider ? `transcript/${provider}` : "transcript");
  }

  if (args.format === "markdown") {
    const strategy = String(args.extracted.diagnostics.strategy ?? "");
    const firecrawlUsed =
      strategy === "firecrawl" || Boolean(args.extracted.diagnostics.firecrawl?.used);
    if (firecrawlUsed) return finish("firecrawl");
    if (strategy === "html" && args.markdownMode === "readability") {
      return finish("readability");
    }

    const mdUsed = Boolean(args.extracted.diagnostics.markdown?.used);
    const mdProvider = args.extracted.diagnostics.markdown.provider;
    const mdNotes = args.extracted.diagnostics.markdown.notes ?? null;

    if (mdUsed && mdProvider === "firecrawl") {
      return finish("firecrawl");
    }
    if (
      mdUsed &&
      mdNotes &&
      mdNotes
        .toLowerCase()
        .includes(/* i18n-ignore: Core extraction diagnostic marker. */ "readability html used")
    ) {
      return finish("readability");
    }
    if (mdUsed) {
      if (args.markdownMode === "readability") return finish("readability");
      if (args.hasMarkdownLlmCall) return finish("llm");
      if (mdNotes === "markitdown+ocr") return finish("markitdown+ocr");
      return finish("markitdown");
    }
  }

  const strategy = String(args.extracted.diagnostics.strategy ?? "");
  if (strategy === "firecrawl" || args.extracted.diagnostics.firecrawl?.used) {
    return finish("firecrawl");
  }
  if (strategy === "xurl") return finish("xurl");
  if (strategy === "bird") return finish("bird");
  if (strategy === "twitter-syndication") return finish("twitter-syndication");
  if (strategy === "nitter") return finish("nitter");
  return finish();
}

export function buildSummaryFinishLabel(args: {
  extracted: { diagnostics: ExtractDiagnosticsForFinishLine; wordCount: number };
}): FinishLabel | null {
  const strategy = String(args.extracted.diagnostics.strategy ?? "");
  const sources: string[] = [];
  if (strategy === "xurl") sources.push("xurl");
  if (strategy === "bird") sources.push("bird");
  if (strategy === "twitter-syndication") sources.push("twitter-syndication");
  if (strategy === "nitter") sources.push("nitter");
  if (strategy === "firecrawl" || args.extracted.diagnostics.firecrawl?.used) {
    sources.push("firecrawl");
  }
  const transcriptProvided = Boolean(args.extracted.diagnostics.transcript?.textProvided);
  const words =
    typeof args.extracted.wordCount === "number" && Number.isFinite(args.extracted.wordCount)
      ? args.extracted.wordCount
      : 0;
  if (transcriptProvided && sources.length === 0) return null;
  if (!transcriptProvided && sources.length === 0 && words <= 0) return null;
  return { kind: "summary", words: transcriptProvided ? 0 : words, sources };
}
