import { parseSseStream } from "@steipete/summarize-core/runtime";
import { buildBrowserSummaryPayload } from "../../lib/browser-summary";
import { fetchBrowserUrlContent } from "../../lib/browser-url-content";
import { daemonFetch } from "../../lib/daemon-fetch";
import { daemonOrigin } from "../../lib/daemon-url";
import {
  buildDirectSummaryPrompt,
  DIRECT_SUMMARY_SYSTEM_PROMPT,
  resolveDirectMaxTokens,
} from "../../lib/direct-prompts";
import { completeDirectText } from "../../lib/direct-provider";
import { resolveSummaryExecution } from "../../lib/model-routing";
import { parseSseEvent } from "../../lib/runtime-contracts";
import { getProviderSettings, loadSettings } from "../../lib/settings";
import { getActiveTabUrl } from "./active-tab";

export type SummarizeToolArgs = {
  url?: string;
  extractOnly?: boolean;
  format?: "text" | "markdown";
  markdownMode?: "off" | "auto" | "llm" | "readability";
  model?: string;
  length?: string;
  language?: string;
  prompt?: string;
  timeout?: string;
  maxOutputTokens?: string | number;
  noCache?: boolean;
  firecrawl?: "off" | "auto" | "always";
  preprocess?: "off" | "auto" | "always";
  youtube?: "auto" | "web" | "yt-dlp" | "apify" | "no-auto";
  videoMode?: "auto" | "transcript" | "understand";
  embeddedVideo?: "auto" | "off" | "prefer" | "both";
  timestamps?: boolean;
  maxCharacters?: number;
};

type SummarizeToolResult = {
  text: string;
  details?: Record<string, unknown>;
};

export async function executeSummarizeTool(args: SummarizeToolArgs): Promise<SummarizeToolResult> {
  const settings = await loadSettings();
  const effectiveSettings = {
    ...settings,
    model: args.model ?? settings.model,
    length: args.length ?? settings.length,
    language: args.language ?? settings.language,
    promptOverride: args.prompt ?? settings.promptOverride,
    maxOutputTokens:
      typeof args.maxOutputTokens === "number"
        ? String(args.maxOutputTokens)
        : (args.maxOutputTokens ?? settings.maxOutputTokens),
  };
  const summaryExecution = resolveSummaryExecution(effectiveSettings);
  const token = settings.token.trim();
  if (summaryExecution === "daemon" && !token) {
    throw new Error("Missing daemon token. Open the side panel setup to pair the daemon.");
  }

  const url = (args.url ?? (await getActiveTabUrl()))?.trim();
  if (!url) throw new Error("Missing URL (no active tab)");

  const format = args.format === "markdown" ? "markdown" : "text";
  const extractOnly = Boolean(args.extractOnly);
  if (summaryExecution !== "daemon") {
    const content = await fetchBrowserUrlContent({
      url,
      maxCharacters:
        typeof args.maxCharacters === "number" && Number.isFinite(args.maxCharacters)
          ? args.maxCharacters
          : settings.maxChars,
    });
    if (extractOnly) {
      return {
        text: content.text,
        details: {
          url: content.url,
          title: content.title,
          truncated: content.truncated,
          format,
          runtime: "browser",
        },
      };
    }
    if (summaryExecution === "browser") {
      const summary = buildBrowserSummaryPayload({
        title: content.title,
        text: content.text,
        transcriptTimedText: null,
      });
      return {
        text: summary.markdown,
        details: { url: content.url, title: content.title, runtime: "browser" },
      };
    }
    const result = await completeDirectText({
      model: effectiveSettings.model,
      providerSettings: getProviderSettings(effectiveSettings),
      system: DIRECT_SUMMARY_SYSTEM_PROMPT,
      prompt: buildDirectSummaryPrompt({
        url: content.url,
        title: content.title,
        text: content.text,
        truncated: content.truncated,
        settings: effectiveSettings,
      }),
      maxTokens: resolveDirectMaxTokens(effectiveSettings),
      signal: new AbortController().signal,
    });
    return {
      text: result.text,
      details: {
        url: content.url,
        title: content.title,
        runtime: "direct",
        provider: result.config.provider,
        model: result.config.model,
      },
    };
  }

  const body: Record<string, unknown> = { url, mode: "url", format, extractOnly };
  const model = args.model ?? settings.model;
  if (model) body.model = model;
  if (!extractOnly) {
    const length = args.length ?? settings.length;
    if (length) body.length = length;
  }
  const language = args.language ?? settings.language;
  if (language) body.language = language;
  const prompt = args.prompt ?? settings.promptOverride;
  if (prompt) body.prompt = prompt;
  const timeout = args.timeout ?? settings.timeout;
  if (timeout) body.timeout = timeout;
  const maxOutputTokens = args.maxOutputTokens ?? settings.maxOutputTokens;
  if (maxOutputTokens) body.maxOutputTokens = maxOutputTokens;
  if (args.noCache) body.noCache = true;
  const firecrawl = args.firecrawl ?? settings.firecrawlMode;
  if (firecrawl) body.firecrawl = firecrawl;
  const markdownMode = args.markdownMode ?? settings.markdownMode;
  if (markdownMode) body.markdownMode = markdownMode;
  const preprocess = args.preprocess ?? settings.preprocessMode;
  if (preprocess) body.preprocess = preprocess;
  const youtube = args.youtube ?? settings.youtubeMode;
  if (youtube) body.youtube = youtube;
  if (args.videoMode) body.videoMode = args.videoMode;
  if (args.embeddedVideo) body.embeddedVideo = args.embeddedVideo;
  if (typeof args.timestamps === "boolean") body.timestamps = args.timestamps;
  if (typeof args.maxCharacters === "number" && Number.isFinite(args.maxCharacters)) {
    body.maxCharacters = args.maxCharacters;
  } else if (typeof settings.maxChars === "number" && Number.isFinite(settings.maxChars)) {
    body.maxCharacters = settings.maxChars;
  }

  const origin = daemonOrigin(settings.daemonPort);
  const res = await daemonFetch(`${origin}/v1/summarize`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as
    | { ok: true; id: string }
    | { ok: true; extracted: { content: string } & Record<string, unknown> }
    | { ok: false; error?: string };
  if (!res.ok || !json.ok) {
    const error = (json as { error?: string }).error ?? `${res.status} ${res.statusText}`.trim();
    throw new Error(error || "Summarize failed");
  }
  if (extractOnly) {
    if (!("extracted" in json) || !json.extracted) throw new Error("Missing extracted content");
    return { text: json.extracted.content, details: json.extracted };
  }
  if (!("id" in json) || !json.id) throw new Error("Missing summarize run id");

  const streamRes = await daemonFetch(`${origin}/v1/summarize/${json.id}/events`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!streamRes.ok) throw new Error(`${streamRes.status} ${streamRes.statusText}`);
  if (!streamRes.body) throw new Error("Missing stream body");

  let output = "";
  let meta: Record<string, unknown> | null = null;
  for await (const raw of parseSseStream(streamRes.body)) {
    const event = parseSseEvent(raw);
    if (!event) continue;
    if (event.event === "chunk") {
      output += event.data.text;
    } else if (event.event === "meta") {
      meta = event.data;
    } else if (event.event === "error") {
      throw new Error(event.data.message || "Summarize failed");
    } else if (event.event === "done") {
      break;
    }
  }

  const text = output.trim();
  if (!text) throw new Error("Model returned no output");
  return { text, details: meta ?? undefined };
}
