import { createHash } from "node:crypto";
import type { LengthArg } from "./flags.js";
import type { OutputLanguage } from "./language.js";

export function hashString(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function hashJson(value: unknown): string {
  return hashString(JSON.stringify(value));
}

export function normalizeContentForHash(content: string): string {
  return content.replaceAll("\r\n", "\n").trim();
}

export function extractTaggedBlock(
  prompt: string,
  tag: "instructions" | "content" | "context",
): string | null {
  const open = `<${tag}>`;
  const close = `</${tag}>`;
  const start = prompt.indexOf(open);
  if (start === -1) return null;
  const end = prompt.indexOf(close, start + open.length);
  if (end === -1) return null;
  return prompt.slice(start + open.length, end).trim();
}

export function buildPromptHash(prompt: string): string {
  const instructions = extractTaggedBlock(prompt, "instructions") ?? "";
  const context = extractTaggedBlock(prompt, "context") ?? "";

  // If we have both, we hash both. If we have only one, we hash that.
  // If we have neither (tags missing), we hash the whole trimmed prompt.
  if (instructions || context) {
    return hashString(`${instructions}\n${context}`.trim());
  }

  return hashString(prompt.trim());
}

export function buildPromptContentHash({
  prompt,
  fallbackContent,
}: {
  prompt: string;
  fallbackContent?: string | null;
}): string | null {
  const content = extractTaggedBlock(prompt, "content") ?? fallbackContent ?? null;
  if (!content || content.trim().length === 0) return null;
  return hashString(normalizeContentForHash(content));
}

export function buildLengthKey(lengthArg: LengthArg): string {
  return lengthArg.kind === "preset"
    ? `preset:${lengthArg.preset}`
    : `chars:${lengthArg.maxCharacters}`;
}

export function buildLanguageKey(outputLanguage: OutputLanguage): string {
  return outputLanguage.kind === "auto" ? "auto" : outputLanguage.tag;
}

export function buildExtractCacheKeyValue({
  url,
  options,
  formatVersion,
}: {
  url: string;
  options: Record<string, unknown>;
  formatVersion: number;
}): string {
  return hashJson({ url, options, formatVersion });
}

export function buildSummaryCacheKeyValue({
  contentHash,
  promptHash,
  model,
  lengthKey,
  languageKey,
  formatVersion,
}: {
  contentHash: string;
  promptHash: string;
  model: string;
  lengthKey: string;
  languageKey: string;
  formatVersion: number;
}): string {
  return hashJson({
    contentHash,
    promptHash,
    model,
    lengthKey,
    languageKey,
    formatVersion,
  });
}

export function buildSlidesCacheKeyValue({
  url,
  settings,
  formatVersion,
}: {
  url: string;
  settings: {
    ocr: boolean;
    outputDir: string;
    sceneThreshold: number;
    autoTuneThreshold: boolean;
    maxSlides: number;
    minDurationSeconds: number;
  };
  formatVersion: number;
}): string {
  return hashJson({
    url,
    settings: {
      ocr: settings.ocr,
      outputDir: settings.outputDir,
      sceneThreshold: settings.sceneThreshold,
      autoTuneThreshold: settings.autoTuneThreshold,
      maxSlides: settings.maxSlides,
      minDurationSeconds: settings.minDurationSeconds,
    },
    formatVersion,
  });
}

export function buildTranscriptCacheKeyValue({
  url,
  namespace,
  formatVersion,
  fileMtime,
}: {
  url: string;
  namespace: string | null;
  formatVersion: number;
  fileMtime?: number | null;
}): string {
  return hashJson({
    url,
    namespace,
    fileMtime: fileMtime ?? null,
    formatVersion,
  });
}
