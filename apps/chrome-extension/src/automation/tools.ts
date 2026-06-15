import type { ToolCall, ToolResultMessage } from "@earendil-works/pi-ai";
import { buildBrowserSummaryPayload } from "../lib/browser-summary";
import { fetchBrowserUrlContent } from "../lib/browser-url-content";
import {
  buildDirectSummaryPrompt,
  DIRECT_SUMMARY_SYSTEM_PROMPT,
  resolveDirectMaxTokens,
} from "../lib/direct-prompts";
import { completeDirectText } from "../lib/direct-provider";
import { resolveSummaryExecution } from "../lib/model-routing";
import { parseSseEvent } from "../lib/runtime-contracts";
import { getProviderSettings, loadSettings } from "../lib/settings";
import { parseSseStream } from "../lib/sse";
import {
  deleteArtifact,
  getArtifactRecord,
  listArtifacts,
  parseArtifact,
  upsertArtifact,
} from "./artifacts-store";
import { executeAskUserWhichElementTool } from "./ask-user-which-element";
import { executeNavigateTool } from "./navigate";
import { executeReplTool } from "./repl";
import { executeSkillTool, type SkillToolArgs } from "./skills";

const TOOL_NAMES = [
  "navigate",
  "repl",
  "ask_user_which_element",
  "skill",
  "artifacts",
  "summarize",
  "debugger",
] as const;

export type AutomationToolName = (typeof TOOL_NAMES)[number];

export function getAutomationToolNames(): AutomationToolName[] {
  return [...TOOL_NAMES];
}

function buildToolResultMessage({
  toolCallId,
  toolName,
  text,
  isError,
  details,
}: {
  toolCallId: string;
  toolName: string;
  text: string;
  isError: boolean;
  details?: unknown;
}): ToolResultMessage {
  return {
    role: "toolResult",
    toolCallId,
    toolName,
    content: [{ type: "text", text }],
    details,
    isError,
    timestamp: Date.now(),
  };
}

async function getActiveTabUrl(): Promise<string | null> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab?.url ?? null;
}

async function getActiveTabId(): Promise<number> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error("No active tab");
  return tab.id;
}

type SummarizeToolArgs = {
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

async function executeSummarizeTool(args: SummarizeToolArgs): Promise<SummarizeToolResult> {
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

  const body: Record<string, unknown> = {
    url,
    mode: "url",
    format,
    extractOnly,
  };

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

  const res = await fetch("http://127.0.0.1:8787/v1/summarize", {
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
    if (!("extracted" in json) || !json.extracted) {
      throw new Error("Missing extracted content");
    }
    return {
      text: json.extracted.content,
      details: json.extracted,
    };
  }

  if (!("id" in json) || !json.id) {
    throw new Error("Missing summarize run id");
  }

  const streamRes = await fetch(`http://127.0.0.1:8787/v1/summarize/${json.id}/events`, {
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
      continue;
    }
    if (event.event === "meta") {
      meta = event.data;
      continue;
    }
    if (event.event === "error") {
      throw new Error(event.data.message || "Summarize failed");
    }
    if (event.event === "done") break;
  }

  const text = output.trim();
  if (!text) {
    throw new Error("Model returned no output");
  }

  return { text, details: meta ?? undefined };
}

type ArtifactsToolArgs = {
  action: "list" | "get" | "create" | "update" | "delete";
  fileName?: string;
  content?: unknown;
  mimeType?: string;
  contentBase64?: string;
  asBase64?: boolean;
};

type ArtifactInfo = {
  fileName: string;
  mimeType: string;
  size: number;
  updatedAt: string;
};

function formatArtifactValue(value: unknown): string {
  if (value == null) return "null";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

// Artifacts are stored per active tab session and can be created/updated from both REPL and tools.
async function executeArtifactsTool(
  args: ArtifactsToolArgs,
): Promise<{ text: string; details?: unknown }> {
  const tabId = await getActiveTabId();
  const action = args.action;

  if (action === "list") {
    const records = await listArtifacts(tabId);
    const items: ArtifactInfo[] = records.map((record) => ({
      fileName: record.fileName,
      mimeType: record.mimeType,
      size: record.size,
      updatedAt: record.updatedAt,
    }));
    const text =
      items.length === 0
        ? "No artifacts found."
        : items
            .map((item) => `- ${item.fileName} (${item.mimeType}, ${item.size} bytes)`)
            .join("\n");
    return { text, details: { artifacts: items } };
  }

  if (!args.fileName) throw new Error("Missing fileName");

  if (action === "get") {
    const record = await getArtifactRecord(tabId, args.fileName);
    if (!record) throw new Error(`Artifact not found: ${args.fileName}`);
    if (args.asBase64) {
      const text = formatArtifactValue(record);
      return { text, details: { artifact: record } };
    }
    const isText =
      record.mimeType.startsWith("text/") ||
      record.mimeType === "application/json" ||
      record.fileName.endsWith(".json");
    const value = isText ? parseArtifact(record) : record;
    const text = formatArtifactValue(value);
    return { text, details: { artifact: record } };
  }

  if (action === "create") {
    const existing = await getArtifactRecord(tabId, args.fileName);
    if (existing) throw new Error(`Artifact already exists: ${args.fileName}`);
  }

  if (action === "update") {
    const existing = await getArtifactRecord(tabId, args.fileName);
    if (!existing) throw new Error(`Artifact not found: ${args.fileName}`);
  }

  if (action === "create" || action === "update") {
    const record = await upsertArtifact(tabId, {
      fileName: args.fileName,
      content: args.content,
      mimeType: args.mimeType,
      contentBase64: args.contentBase64,
    });
    return {
      text: `Saved artifact ${record.fileName} (${record.mimeType}, ${record.size} bytes)`,
      details: { artifact: record },
    };
  }

  if (action === "delete") {
    const deleted = await deleteArtifact(tabId, args.fileName);
    return {
      text: deleted ? `Deleted artifact ${args.fileName}` : `Artifact not found: ${args.fileName}`,
    };
  }

  throw new Error(`Unknown artifacts action: ${action}`);
}

function maybeNotifyUserScriptsNotice(message: string) {
  if (typeof window === "undefined") return;
  if (!/user scripts|userscripts/i.test(message)) return;
  window.dispatchEvent(
    new CustomEvent("summarize:automation-permissions", {
      detail: {
        title: "User Scripts required",
        message,
        ctaLabel: "Open extension details",
        ctaAction: "extensions",
      },
    }),
  );
}

async function executeDebuggerTool(args: { action?: string; code?: string }) {
  if (args.action !== "eval") throw new Error("Unsupported debugger action");
  if (!args.code) throw new Error("Missing code");

  const hasPermission = await chrome.permissions.contains({ permissions: ["debugger"] });
  if (!hasPermission) {
    throw new Error(
      "Debugger permission not granted. Enable it in Options → Automation permissions.",
    );
  }

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error("No active tab");

  const tabId = tab.id;
  try {
    await chrome.debugger.attach({ tabId }, "1.3");
  } catch (err) {
    if (!(err instanceof Error) || !err.message.includes("already attached")) {
      throw err;
    }
  }

  try {
    const result = await chrome.debugger.sendCommand({ tabId }, "Runtime.evaluate", {
      expression: args.code,
      returnByValue: true,
    });
    const value = result?.result?.value ?? result?.result ?? null;
    const text =
      value == null ? "null" : typeof value === "string" ? value : JSON.stringify(value, null, 2);
    return { text, details: result };
  } finally {
    try {
      await chrome.debugger.detach({ tabId });
    } catch {
      // ignore
    }
  }
}

export async function executeToolCall(toolCall: ToolCall): Promise<ToolResultMessage> {
  try {
    if (toolCall.name === "navigate") {
      const result = await executeNavigateTool(
        toolCall.arguments as {
          url?: string;
          newTab?: boolean;
          listTabs?: boolean;
          switchToTab?: number;
        },
      );
      let text = "";
      if (result.tabs) {
        text =
          result.tabs.length === 0
            ? "No open tabs."
            : result.tabs
                .map((tab) => `- [${tab.id}] ${tab.title ?? "Untitled"} (${tab.url ?? "no url"})`)
                .join("\n");
      } else if (typeof result.switchedToTab === "number") {
        text = `Switched to tab ${result.switchedToTab}${result.finalUrl ? `: ${result.finalUrl}` : ""}`;
      } else {
        text = `Navigated to ${result.finalUrl ?? "unknown url"}`;
      }

      if (result.skills && result.skills.length > 0) {
        const skillLines = result.skills.map(
          (skill) => `- ${skill.name}: ${skill.shortDescription}`,
        );
        text = `${text}\n\nSkills:\n${skillLines.join("\n")}`;
      }
      return buildToolResultMessage({
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        text,
        isError: false,
        details: result,
      });
    }

    if (toolCall.name === "repl") {
      const result = await executeReplTool(toolCall.arguments as { title: string; code: string });
      return buildToolResultMessage({
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        text: result.output,
        isError: false,
        details: result.files?.length ? { files: result.files } : undefined,
      });
    }

    if (toolCall.name === "ask_user_which_element") {
      const result = await executeAskUserWhichElementTool(
        toolCall.arguments as { message?: string },
      );
      return buildToolResultMessage({
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        text: `Selected ${result.selector}`,
        isError: false,
        details: result,
      });
    }

    if (toolCall.name === "skill") {
      const result = await executeSkillTool(toolCall.arguments as SkillToolArgs, getActiveTabUrl);
      return buildToolResultMessage({
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        text: result.text,
        isError: false,
        details: result.details,
      });
    }

    if (toolCall.name === "debugger") {
      const result = await executeDebuggerTool(
        toolCall.arguments as { action?: string; code?: string },
      );
      return buildToolResultMessage({
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        text: result.text,
        isError: false,
        details: result.details,
      });
    }

    if (toolCall.name === "summarize") {
      const result = await executeSummarizeTool(toolCall.arguments as SummarizeToolArgs);
      return buildToolResultMessage({
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        text: result.text,
        isError: false,
        details: result.details,
      });
    }

    if (toolCall.name === "artifacts") {
      const result = await executeArtifactsTool(toolCall.arguments as ArtifactsToolArgs);
      return buildToolResultMessage({
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        text: result.text,
        isError: false,
        details: result.details,
      });
    }

    return buildToolResultMessage({
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      text: `Unknown tool: ${toolCall.name}`,
      isError: true,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (toolCall.name === "repl") {
      maybeNotifyUserScriptsNotice(message);
    }
    return buildToolResultMessage({
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      text: message,
      isError: true,
    });
  }
}
