/**
 * MCP (Model Context Protocol) server for summarize.
 *
 * Exposes summarize's content extraction and summarization capabilities
 * as MCP tools, usable by Claude Code, Cursor, and other MCP clients.
 *
 * Transport: stdio (JSON-RPC over stdin/stdout).
 * All diagnostic/progress output goes to stderr to avoid corrupting the protocol.
 */

import { Writable } from "node:stream";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { runCli } from "../run.js";
import { resolvePackageVersion } from "../version.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Collect everything written to a Writable into a string. */
function createStringCollector(): { stream: Writable; collect: () => string } {
  const chunks: Buffer[] = [];
  const stream = new Writable({
    write(chunk, _encoding, cb) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      cb();
    },
  });
  return {
    stream,
    collect: () => Buffer.concat(chunks).toString("utf8"),
  };
}

/** Run the CLI with the given argv and capture stdout/stderr. */
async function runCliCapture(
  argv: string[],
  env: Record<string, string | undefined>,
): Promise<{ stdout: string; stderr: string; error?: string }> {
  const out = createStringCollector();
  const err = createStringCollector();

  try {
    await runCli(argv, {
      env: { ...env },
      fetch: globalThis.fetch.bind(globalThis),
      stdout: out.stream,
      stderr: err.stream,
    });
    return { stdout: out.collect(), stderr: err.collect() };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return { stdout: out.collect(), stderr: err.collect(), error: message };
  }
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

const TOOLS = [
  {
    name: "summarize",
    description:
      "Summarize a web page, YouTube video, or local file. Returns an LLM-generated summary of the content. Supports configurable length, language, and model selection.",
    inputSchema: {
      type: "object" as const,
      properties: {
        url: {
          type: "string",
          description: "URL to summarize (web page, YouTube video, etc.)",
        },
        file: {
          type: "string",
          description: "Local file path to summarize (alternative to url)",
        },
        length: {
          type: "string",
          description:
            "Summary length: short, medium, long, xl, xxl (or s/m/l), or a character limit like 20000 or 20k",
          default: "xl",
        },
        language: {
          type: "string",
          description:
            "Output language: auto (match source), en, de, zh, ja, etc. Default: auto",
        },
        model: {
          type: "string",
          description:
            "LLM model to use: auto, openai/gpt-4o, anthropic/claude-sonnet-4-20250514, google/gemini-2.5-flash, etc.",
        },
        prompt: {
          type: "string",
          description:
            "Custom prompt to override the default summary instruction",
        },
      },
      required: [],
    },
  },
  {
    name: "extract",
    description:
      "Extract the full text or markdown content from a web page, YouTube transcript, or local file without summarizing. Returns the raw extracted content.",
    inputSchema: {
      type: "object" as const,
      properties: {
        url: {
          type: "string",
          description: "URL to extract content from",
        },
        file: {
          type: "string",
          description: "Local file path to extract content from (alternative to url)",
        },
        format: {
          type: "string",
          enum: ["text", "md"],
          description: "Output format: text (plain text) or md (markdown). Default: text",
          default: "text",
        },
        maxCharacters: {
          type: "number",
          description: "Maximum characters to extract (default: unlimited)",
        },
      },
      required: [],
    },
  },
] as const;

// ---------------------------------------------------------------------------
// Tool handlers
// ---------------------------------------------------------------------------

function resolveInput(args: Record<string, unknown>): string | null {
  if (typeof args.url === "string" && args.url.trim()) return args.url.trim();
  if (typeof args.file === "string" && args.file.trim()) return args.file.trim();
  return null;
}

async function handleSummarize(
  args: Record<string, unknown>,
  env: Record<string, string | undefined>,
) {
  const input = resolveInput(args);
  if (!input) {
    return {
      content: [{ type: "text" as const, text: "Error: provide either 'url' or 'file' parameter." }],
      isError: true,
    };
  }

  const argv: string[] = [input, "--json", "--no-color", "--stream", "off"];

  if (typeof args.length === "string") argv.push("--length", args.length);
  if (typeof args.language === "string") argv.push("--language", args.language);
  if (typeof args.model === "string") argv.push("--model", args.model);
  if (typeof args.prompt === "string") argv.push("--prompt", args.prompt);

  const result = await runCliCapture(argv, env);

  if (result.error) {
    return {
      content: [{ type: "text" as const, text: `Error: ${result.error}` }],
      isError: true,
    };
  }

  // Parse JSON output to extract just the summary for cleaner response
  try {
    const json = JSON.parse(result.stdout);
    const summary = typeof json.summary === "string" ? json.summary : result.stdout;
    const parts: Array<{ type: "text"; text: string }> = [
      { type: "text", text: summary },
    ];

    // Append metadata if available
    const meta: string[] = [];
    if (json.llm?.model) meta.push(`Model: ${json.llm.model}`);
    if (json.extracted?.title) meta.push(`Title: ${json.extracted.title}`);
    if (json.extracted?.wordCount) meta.push(`Source words: ${json.extracted.wordCount}`);
    if (json.metrics?.summary?.totalTokens) meta.push(`Tokens: ${json.metrics.summary.totalTokens}`);
    if (meta.length > 0) {
      parts.push({ type: "text", text: `\n---\n${meta.join(" | ")}` });
    }

    return { content: parts };
  } catch {
    // If JSON parsing fails, return raw stdout
    const text = result.stdout.trim() || result.stderr.trim() || "No output produced.";
    return { content: [{ type: "text" as const, text }] };
  }
}

async function handleExtract(
  args: Record<string, unknown>,
  env: Record<string, string | undefined>,
) {
  const input = resolveInput(args);
  if (!input) {
    return {
      content: [{ type: "text" as const, text: "Error: provide either 'url' or 'file' parameter." }],
      isError: true,
    };
  }

  const argv: string[] = [input, "--extract", "--plain", "--no-color"];

  if (typeof args.format === "string") argv.push("--format", args.format);
  if (typeof args.maxCharacters === "number") {
    argv.push("--max-extract-characters", String(args.maxCharacters));
  }

  const result = await runCliCapture(argv, env);

  if (result.error) {
    return {
      content: [{ type: "text" as const, text: `Error: ${result.error}` }],
      isError: true,
    };
  }

  const text = result.stdout.trim() || "No content extracted.";
  return { content: [{ type: "text" as const, text }] };
}

// ---------------------------------------------------------------------------
// Server setup
// ---------------------------------------------------------------------------

export async function runMcpServer(): Promise<void> {
  const version = resolvePackageVersion() ?? "0.0.0";

  const server = new Server(
    { name: "summarize", version },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [...TOOLS],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const env = { ...process.env };

    switch (name) {
      case "summarize":
        return handleSummarize((args ?? {}) as Record<string, unknown>, env);
      case "extract":
        return handleExtract((args ?? {}) as Record<string, unknown>, env);
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Graceful shutdown
  const shutdown = async () => {
    await server.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
