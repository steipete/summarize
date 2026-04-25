import type { ExtractResponse } from "../content-script-bridge";

export type ExtractLog = (event: string, detail?: Record<string, unknown>) => void;

export type ExtractorContext = {
  tabId: number;
  url: string;
  title: string | null;
  maxChars: number;
  minTextChars: number;
  token: string;
  noCache?: boolean;
  includeDiagnostics?: boolean;
  signal?: AbortSignal;
  fetchImpl: typeof fetch;
  extractFromTab: (
    tabId: number,
    maxCharacters: number,
    opts?: {
      timeoutMs?: number;
      log?: ExtractLog;
    },
  ) => Promise<{ ok: true; data: ExtractResponse & { ok: true } } | { ok: false; error: string }>;
  log: ExtractLog;
};

export type ExtractorResult = {
  extracted: ExtractResponse & { ok: true };
  source: "page" | "url";
  diagnostics?: {
    strategy: string;
    markdown?: { used?: boolean; provider?: string | null } | null;
    firecrawl?: { used?: boolean } | null;
    transcript?: {
      provider?: string | null;
      cacheStatus?: string | null;
      attemptedProviders?: string[] | null;
    } | null;
  } | null;
};

export type Extractor = {
  name: string;
  match: (ctx: ExtractorContext) => boolean;
  extract: (ctx: ExtractorContext) => Promise<ExtractorResult | null>;
};
