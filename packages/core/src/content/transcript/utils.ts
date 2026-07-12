import { parseHtmlDocument } from "../html-document.js";
import { extractYouTubeVideoId } from "../url.js";

export { extractYouTubeVideoId, isLoomVideoUrl, isYouTubeUrl, isYouTubeVideoUrl } from "../url.js";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
export function sanitizeYoutubeJsonResponse(input: string): string {
  const trimmed = input.trimStart();
  if (trimmed.startsWith(")]}'")) {
    return trimmed.slice(4);
  }
  return trimmed;
}

export function decodeHtmlEntities(input: string): string {
  return input
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&#x27;", "'")
    .replaceAll("&#x2F;", "/")
    .replaceAll("&nbsp;", " ");
}

export function extractYoutubeBootstrapConfig(html: string): Record<string, unknown> | null {
  const parsed = parseHtmlDocument(html);
  try {
    const scripts = parsed.document.querySelectorAll("script");

    for (const script of scripts) {
      const source = script.textContent;
      if (!source) {
        continue;
      }

      const config = parseBootstrapFromScript(source);
      if (config) {
        return config;
      }
    }
  } catch {
    // fall through to legacy regex
  } finally {
    parsed.close();
  }

  return parseBootstrapFromScript(html);
}

const YTCFG_SET_TOKEN = "ytcfg.set";
const YTCFG_VAR_TOKEN = "var ytcfg";

function extractBalancedJsonObject(source: string, startAt: number): string | null {
  const start = source.indexOf("{", startAt);
  if (start < 0) {
    return null;
  }

  let depth = 0;
  let inString = false;
  let quote: '"' | "'" | null = null;
  let escaping = false;

  for (let i = start; i < source.length; i += 1) {
    const ch = source[i];
    if (!ch) {
      continue;
    }

    if (inString) {
      if (escaping) {
        escaping = false;
        continue;
      }
      if (ch === "\\") {
        escaping = true;
        continue;
      }
      if (quote && ch === quote) {
        inString = false;
        quote = null;
      }
      continue;
    }

    if (ch === '"' || ch === "'") {
      inString = true;
      quote = ch;
      continue;
    }

    if (ch === "{") {
      depth += 1;
      continue;
    }
    if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        return source.slice(start, i + 1);
      }
    }
  }

  return null;
}

function parseBootstrapFromScript(source: string): Record<string, unknown> | null {
  const sanitizedSource = sanitizeYoutubeJsonResponse(source.trimStart());

  for (let index = 0; index >= 0; ) {
    index = sanitizedSource.indexOf(YTCFG_SET_TOKEN, index);
    if (index < 0) {
      break;
    }
    const object = extractBalancedJsonObject(sanitizedSource, index);
    if (object) {
      try {
        const parsed: unknown = JSON.parse(object);
        if (isRecord(parsed)) {
          return parsed;
        }
      } catch {
        // keep searching
      }
    }
    index += YTCFG_SET_TOKEN.length;
  }

  const varIndex = sanitizedSource.indexOf(YTCFG_VAR_TOKEN);
  if (varIndex >= 0) {
    const object = extractBalancedJsonObject(sanitizedSource, varIndex);
    if (object) {
      try {
        const parsed: unknown = JSON.parse(object);
        if (isRecord(parsed)) {
          return parsed;
        }
      } catch {
        return null;
      }
    }
  }

  return null;
}
