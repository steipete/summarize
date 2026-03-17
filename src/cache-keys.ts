import { createHash } from "node:crypto";
import type { LengthArg } from "./flags.js";
import type { OutputLanguage } from "./language.js";

export function hashString(strValue: string): string {
  return createHash("sha256").update(strValue).digest("hex");
}

export function hashJson(jsonValue: unknown): string {
  return hashString(JSON.stringify(jsonValue));
}

export function normalizeContentForHash(content: string): string {
  return content.replaceAll("\r\n", "\n").trim();
}

export function extractTaggedBlock(promptText: string, tag: "instructions" | "content"): string | null {
  const open = `<${tag}>`;
  const close = `</${tag}>`;
  const start = promptText.indexOf(open);
  if (start === -1) return null;
  const end = promptText.indexOf(close, start + open.length);
  if (end === -1) return null;
  return promptText.slice(start + open.length, end).trim();
}

export function buildPromptHash(prompt: string): string {
  const instructions = extractTaggedBlock(prompt, "instructions") ?? prompt;
  return hashString(instructions.trim());
}

export function buildPromptContentHash(promptFallbackContent: {
  prompt: string;
  fallbackContent?: string | null;
}): string | null {
  const { prompt, fallbackContent } = promptFallbackContent;
  const content = extractTaggedBlock(prompt, "content") ?? fallbackContent ?? null;
  if (!content || content.trim().length === 0) return null;
  return hashString(normalizeContentForHash(content));
}

export function buildLengthKey(lengthArg: LengthArg): string {
  return lengthArg.kind === "preset" ? `preset:${lengthArg.preset}` : `chars:${lengthArg.maxCharacters}`;
}

export function buildLanguageKey(outputLanguage: OutputLanguage): string {
  return outputLanguage.kind === "auto" ? "auto" : outputLanguage.tag;
}

export function buildExtractCacheKeyValue(cacheKey: {
  url: string;
  options: Record<string, unknown>;
  formatVersion: number;
}): string {
  return hashJson(cacheKey);
}

export function buildSummaryCacheKeyValue(summaryCacheKey: {
  contentHash: string;
  promptHash: string;
  model: string;
  lengthKey: string;
  languageKey: string;
  formatVersion: number;
}): string {
  return hashJson(summaryCacheKey);
}

export function buildSlidesCacheKeyValue(slidesCacheKey: {
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
  return hashJson(slidesCacheKey);
}

export function buildTranscriptCacheKeyValue(transcriptCacheKey: {
  url: string;
  namespace: string | null;
  formatVersion: number;
  fileMtime?: number | null;
}): string {
  return hashJson({ ...transcriptCacheKey, fileMtime: transcriptCacheKey.fileMtime ?? null });
}
