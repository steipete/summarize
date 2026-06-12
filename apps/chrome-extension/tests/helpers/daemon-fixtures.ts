import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createServer as createNetServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { SummaryLength } from "@steipete/summarize-core";
import { SUMMARY_LENGTH_SPECS } from "@steipete/summarize-core/prompts";
import type { SseSlidesData } from "@steipete/summarize-core/runtime";
import {
  coerceSummaryWithSlides,
  parseSlideSummariesFromMarkdown,
  splitSlideTitleFromText,
} from "@steipete/summarize-core/slides";
import type { ExtensionHarness } from "./extension-harness";
import { getBackground } from "./extension-harness";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..", "..", "..", "..");

export const PLACEHOLDER_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO3kq0cAAAAASUVORK5CYII=",
  "base64",
);

export const SLIDES_MAX = 4;
export const DAEMON_PORT = 8787;
export const DEFAULT_DAEMON_TOKEN = "test-token";
export const BLOCKED_ENV_KEYS = [
  "ANTHROPIC_API_KEY",
  "GEMINI_API_KEY",
  "OPENAI_API_KEY",
  "OPENROUTER_API_KEY",
  "XAI_API_KEY",
  "Z_AI_API_KEY",
  "FAL_KEY",
];

export async function mockDaemonSummarize(harness: ExtensionHarness) {
  const background = await getBackground(harness);
  await background.evaluate(() => {
    const originalFetch =
      (globalThis.__originalFetch as typeof globalThis.fetch | undefined) ?? globalThis.fetch;
    globalThis.__originalFetch = originalFetch;
    if (typeof globalThis.__summarizeCalls !== "number") {
      globalThis.__summarizeCalls = 0;
    }
    if (typeof globalThis.__summarizeRunCount !== "number") {
      globalThis.__summarizeRunCount = 0;
    }
    globalThis.__summarizeLastBody = null;
    globalThis.__summarizeBodies = [];
    globalThis.__summarizeCallTimes = [];
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url === "http://127.0.0.1:8787/health") {
        return new Response("", { status: 200 });
      }
      if (url === "http://127.0.0.1:8787/v1/ping") {
        return new Response("", { status: 200 });
      }
      if (url === "http://127.0.0.1:8787/v1/summarize") {
        globalThis.__summarizeCalls += 1;
        globalThis.__summarizeCallTimes.push(Date.now());
        const body = typeof init?.body === "string" ? init.body : null;
        let parsed: Record<string, unknown> | null = null;
        if (body) {
          try {
            parsed = JSON.parse(body) as Record<string, unknown>;
            globalThis.__summarizeLastBody = parsed;
            globalThis.__summarizeBodies.push(parsed);
          } catch {
            globalThis.__summarizeLastBody = null;
          }
        }
        if (parsed?.extractOnly) {
          return new Response(
            JSON.stringify({
              ok: true,
              extracted: {
                url: typeof parsed.url === "string" ? parsed.url : "",
                title: typeof parsed.title === "string" ? parsed.title : null,
                content: "Transcript text from extract-only request.",
                truncated: false,
                mediaDurationSeconds: 120,
                transcriptTimedText: null,
              },
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        globalThis.__summarizeRunCount += 1;
        return new Response(
          JSON.stringify({ ok: true, id: `run-${globalThis.__summarizeRunCount}` }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      }
      return originalFetch(input, init);
    };
  });
}

export async function getSummarizeCalls(harness: ExtensionHarness) {
  const background = await getBackground(harness);
  return await background.evaluate(() => (globalThis.__summarizeCalls as number | undefined) ?? 0);
}

export async function getSummarizeCallTimes(harness: ExtensionHarness) {
  const background = await getBackground(harness);
  return await background.evaluate(
    () => (globalThis.__summarizeCallTimes as number[] | undefined) ?? [],
  );
}

export async function getSummarizeLastBody(harness: ExtensionHarness) {
  const background = await getBackground(harness);
  return await background.evaluate(() => globalThis.__summarizeLastBody ?? null);
}

export async function getSummarizeBodies(harness: ExtensionHarness) {
  const background = await getBackground(harness);
  return await background.evaluate(
    () => (globalThis.__summarizeBodies as unknown[] | undefined) ?? [],
  );
}

export function hasFfmpeg(): boolean {
  const result = spawnSync("ffmpeg", ["-version"], { stdio: "ignore" });
  return result.status === 0;
}

export function hasYtDlp(): boolean {
  const result = spawnSync("yt-dlp", ["--version"], { stdio: "ignore" });
  return result.status === 0;
}

export async function isPortInUse(port: number): Promise<boolean> {
  return await new Promise((resolve) => {
    const server = createNetServer();
    server.once("error", (err) => {
      const code = (err as NodeJS.ErrnoException).code;
      resolve(code === "EADDRINUSE" || code === "EACCES");
    });
    server.once("listening", () => {
      server.close(() => resolve(false));
    });
    server.listen(port, "127.0.0.1");
  });
}

export function createSampleVideo(outputPath: string) {
  const args = [
    "-y",
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "lavfi",
    "-i",
    "color=c=red:s=640x360:d=2",
    "-f",
    "lavfi",
    "-i",
    "color=c=blue:s=640x360:d=2",
    "-f",
    "lavfi",
    "-i",
    "color=c=green:s=640x360:d=2",
    "-filter_complex",
    "[0:v][1:v][2:v]concat=n=3:v=1:a=0,format=yuv420p",
    "-movflags",
    "faststart",
    outputPath,
  ];
  const result = spawnSync("ffmpeg", args, { stdio: "pipe" });
  if (result.status === 0) return;
  const detail = result.stderr ? result.stderr.toString().trim() : "ffmpeg failed";
  throw new Error(`ffmpeg failed: ${detail}`);
}

export async function waitForSlidesSnapshot(
  runId: string,
  token: string,
  timeoutMs = 60_000,
): Promise<SseSlidesData> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    try {
      const res = await fetch(`http://127.0.0.1:8787/v1/summarize/${runId}/slides`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: controller.signal,
      });
      if (res.ok) {
        const json = (await res.json()) as { ok?: boolean; slides?: { slides?: Array<unknown> } };
        if (json?.ok && json.slides?.slides && json.slides.slides.length > 0) {
          return json.slides;
        }
      }
    } catch {
      // ignore
    } finally {
      clearTimeout(timer);
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error("Timed out waiting for slides snapshot");
}

export async function startDaemonSlidesRun(url: string, token: string): Promise<string> {
  const res = await fetch("http://127.0.0.1:8787/v1/summarize", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      url,
      mode: "url",
      videoMode: "transcript",
      slides: true,
      slidesOcr: true,
      timestamps: true,
      maxCharacters: null,
    }),
  });
  const json = (await res.json()) as { ok?: boolean; id?: string; error?: string };
  if (!res.ok || !json.ok || !json.id) {
    throw new Error(json.error || `${res.status} ${res.statusText}`);
  }
  return json.id;
}

export function readDaemonToken(): string | null {
  const envToken =
    typeof process.env.SUMMARIZE_DAEMON_TOKEN === "string"
      ? process.env.SUMMARIZE_DAEMON_TOKEN.trim()
      : "";
  if (envToken) return envToken;
  try {
    const raw = fs.readFileSync(path.join(os.homedir(), ".summarize", "daemon.json"), "utf8");
    const json = JSON.parse(raw) as { token?: unknown; tokens?: unknown };
    const token = typeof json.token === "string" ? json.token.trim() : "";
    if (token) return token;
    if (Array.isArray(json.tokens)) {
      const fromList = json.tokens.find(
        (value): value is string => typeof value === "string" && value.trim().length > 0,
      );
      return fromList?.trim() || null;
    }
    return null;
  } catch {
    return null;
  }
}

export function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

export function tokenizeForOverlap(value: string): Set<string> {
  const cleaned = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 2);
  return new Set(cleaned);
}

export function overlapRatio(a: string, b: string): number {
  const aTokens = tokenizeForOverlap(a);
  const bTokens = tokenizeForOverlap(b);
  if (aTokens.size === 0 || bTokens.size === 0) return 0;
  let intersection = 0;
  for (const token of aTokens) {
    if (bTokens.has(token)) intersection += 1;
  }
  return intersection / Math.min(aTokens.size, bTokens.size);
}

const SLIDE_CUSTOM_LENGTH_PATTERN = /^(?<value>\d+(?:\.\d+)?)(?<unit>k|m)?$/i;

export function resolveSlidesLengthArg(
  lengthValue: string,
): { kind: "preset"; preset: SummaryLength } | { kind: "chars"; maxCharacters: number } {
  const normalized = lengthValue.trim().toLowerCase();
  if (Object.hasOwn(SUMMARY_LENGTH_SPECS, normalized)) {
    return { kind: "preset", preset: normalized as SummaryLength };
  }
  const match = normalized.match(SLIDE_CUSTOM_LENGTH_PATTERN);
  if (!match) return { kind: "preset", preset: "short" };
  const value = Number(match.groups?.value ?? match[1]);
  if (!Number.isFinite(value) || value <= 0) {
    return { kind: "preset", preset: "short" };
  }
  const unit = (match.groups?.unit ?? "").toLowerCase();
  const multiplier = unit === "m" ? 1_000_000 : unit === "k" ? 1_000 : 1;
  return { kind: "chars", maxCharacters: Math.round(value * multiplier) };
}

export function parseSlidesFromSummary(markdown: string): Array<{ index: number; text: string }> {
  const summaries = parseSlideSummariesFromMarkdown(markdown);
  if (summaries.size === 0) return [];
  const total = summaries.size;
  const entries: Array<{ index: number; text: string }> = [];
  for (const [index, text] of summaries.entries()) {
    const parsed = splitSlideTitleFromText({ text, slideIndex: index, total });
    const body = normalizeWhitespace(parsed.body ?? "");
    entries.push({ index, text: body });
  }
  entries.sort((a, b) => a.index - b.index);
  return entries;
}

export function runCliSummary(url: string, args: string[]): string {
  const env = { ...process.env, NO_COLOR: "1" };
  delete env.FORCE_COLOR;
  const result = spawnSync("pnpm", ["-s", "summarize", "--", ...args, url], {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 50 * 1024 * 1024,
    env,
  });
  if (result.status !== 0) {
    const stderr = result.stderr ? result.stderr.toString().trim() : "";
    const stdout = result.stdout ? result.stdout.toString().trim() : "";
    throw new Error(`CLI summarize failed (${result.status}): ${stderr || stdout}`);
  }
  const output = result.stdout?.toString().trim() ?? "";
  if (!output) {
    throw new Error("CLI summarize returned empty output");
  }
  const parsed = JSON.parse(output) as { summary?: string | null };
  if (!parsed.summary) {
    throw new Error("CLI summarize JSON missing summary");
  }
  return parsed.summary;
}

export async function startDaemonSummaryRun({
  url,
  token,
  length,
  slides,
  slidesMax,
}: {
  url: string;
  token: string;
  length: string;
  slides: boolean;
  slidesMax?: number;
}): Promise<string> {
  const res = await fetch("http://127.0.0.1:8787/v1/summarize", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      url,
      mode: "url",
      videoMode: "transcript",
      timestamps: true,
      length,
      model: "auto",
      ...(slides
        ? {
            slides: true,
            slidesOcr: true,
            ...(typeof slidesMax === "number" && Number.isFinite(slidesMax) ? { slidesMax } : {}),
          }
        : {}),
      maxCharacters: null,
    }),
  });
  const json = (await res.json()) as { ok?: boolean; id?: string; error?: string };
  if (!res.ok || !json.ok || !json.id) {
    throw new Error(json.error || `${res.status} ${res.statusText}`);
  }
  return json.id;
}

export function buildSlidesPayload({
  sourceUrl,
  sourceId,
  count,
  textPrefix,
  sourceKind = "youtube",
}: {
  sourceUrl: string;
  sourceId: string;
  count: number;
  textPrefix: string;
  sourceKind?: string;
}) {
  return {
    sourceUrl,
    sourceId,
    sourceKind,
    ocrAvailable: true,
    slides: Array.from({ length: count }, (_, index) => {
      const slideIndex = index + 1;
      return {
        index: slideIndex,
        timestamp: index * 10,
        imageUrl: `http://127.0.0.1:8787/v1/slides/${sourceId}/${slideIndex}?v=1`,
        ocrText: `${textPrefix} slide ${slideIndex} has enough OCR text to pass thresholds.`,
      };
    }),
  };
}

export async function routePlaceholderSlideImages(page: import("@playwright/test").Page) {
  await page.route("http://127.0.0.1:8787/v1/slides/**", async (route) => {
    await route.fulfill({
      status: 200,
      headers: {
        "content-type": "image/png",
        "x-summarize-slide-ready": "1",
      },
      body: PLACEHOLDER_PNG,
    });
  });
}
