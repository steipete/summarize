import englishMessages from "./localization/en.json" with { type: "json" };
import turkishMessages from "./localization/tr.json" with { type: "json" };
/**
 * Locale for the human-facing CLI. This is deliberately separate from
 * OutputLanguage: --language controls model output, while --locale controls
 * help, progress, and CLI status text.
 */
export type CliLocale = "en" | "tr";

const LOCALE_ALIASES: Record<string, CliLocale> = {
  en: "en",
  english: "en",
  "en-us": "en",
  "en-gb": "en",
  tr: "tr",
  turkish: "tr",
  turkce: "tr",
  "tr-tr": "tr",
};

export function resolveCliLocale(raw: string | null | undefined): CliLocale {
  if (typeof raw !== "string") return "en";
  const normalized = raw.trim().toLowerCase().replaceAll("_", "-").split(/[.@]/, 1)[0];
  return LOCALE_ALIASES[normalized] ?? "en";
}

export function resolveCliLocaleFromEnv(
  env: Record<string, string | undefined>,
  explicit?: string | null,
): CliLocale {
  if (explicit != null && explicit.trim()) return resolveCliLocale(explicit);
  return resolveCliLocale(env.SUMMARIZE_LOCALE);
}

export function resolveCliLocaleFromArgs(
  argv: readonly string[],
  env: Record<string, string | undefined>,
): CliLocale {
  const separatorIndex = argv.indexOf("--");
  const optionArgs = separatorIndex === -1 ? argv : argv.slice(0, separatorIndex);
  const equals = optionArgs.find((arg) => arg.startsWith("--locale="));
  if (equals) return resolveCliLocaleFromEnv(env, equals.slice("--locale=".length));
  const index = optionArgs.indexOf("--locale");
  return resolveCliLocaleFromEnv(env, index >= 0 ? optionArgs[index + 1] : undefined);
}

const TURKISH_TRANSLATIONS: ReadonlyArray<readonly [string, string]> = Object.entries(
  englishMessages,
).map(([key, source]) => [source, turkishMessages[key as keyof typeof turkishMessages]]);

const TRANSLATION_LOOKUP = new Map(TURKISH_TRANSLATIONS);
const TECHNICAL_VALUE_PATTERN =
  /\b(?:auto|off|on|always|detailed|short|medium|long|xl|xxl|none|low|high|xhigh|min|mid|fast|priority|flex|readability|transcript|understand|llm|text|md|kitty|iterm|json|false|true)\b/gi;

function escapeRegExp(value: string): string {
  return value.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function createValueProtector(input: readonly string[]) {
  const values = [...new Set(input.filter(Boolean))].sort((a, b) => b.length - a.length);
  const pattern = values.length > 0 ? new RegExp(values.map(escapeRegExp).join("|"), "g") : null;
  return {
    protect: (text: string) =>
      pattern
        ? text.replace(pattern, (value) => `\u0000value_${values.indexOf(value)}\u0000`)
        : text,
    restore: (text: string) =>
      text.replace(/\u0000value_(\d+)\u0000/g, (_, index: string) => values[Number(index)] ?? ""),
  };
}

function protectTechnicalTokens(text: string): {
  masked: string;
  restore: (value: string) => string;
} {
  const protectedTokens: string[] = [];
  const mask = (value: string) => {
    const index = protectedTokens.push(value) - 1;
    return `\u0000${index}\u0000`;
  };
  let masked = text;
  for (const pattern of [
    /`[^`\n]*`/g,
    /(?:https?|ftp):\/\/[^\s)]+/g,
    /--[A-Za-z0-9][A-Za-z0-9-]*(?:=[^\s]+)?/g,
    /(?:~\/|\.\/|\/)[^\s,)]+/g,
    /\b[A-Za-z][A-Za-z0-9_.-]*(?:\/[A-Za-z0-9_.:@+-]+)+\b/g,
    /\b[A-Z][A-Z0-9_]{2,}\b/g,
    /<[^>\n]+>/g,
    /\b[A-Za-z_][A-Za-z0-9_]*=[A-Za-z0-9_.:-]+\b/g,
    /"[^"\n]*"/g,
    TECHNICAL_VALUE_PATTERN,
  ]) {
    masked = masked.replace(pattern, mask);
  }
  masked = masked.replace(
    /(hizmet katmanı:\s*)default\b/gi,
    (_, prefix: string) => `${prefix}${mask("default")}`,
  );
  return {
    masked,
    restore: (value) =>
      value.replace(
        /\u0000(\d+)\u0000/g,
        (_, index: string) => protectedTokens[Number(index)] ?? "",
      ),
  };
}

/** Translate app-owned text; pass interpolated data as protectedValues to preserve it exactly. */
export function translateCliText(
  text: string,
  locale: CliLocale,
  protectedValues: readonly string[] = [],
): string {
  if (locale === "en") return text;
  const values = createValueProtector(protectedValues);
  let translated = values.protect(text);
  for (const [source, target] of TURKISH_TRANSLATIONS.toSorted(
    (a, b) => b[0].length - a[0].length,
  )) {
    const isSingleWord = /^[A-Za-z]+$/.test(source);
    if (isSingleWord) continue;
    translated = translated.replace(new RegExp(escapeRegExp(source), "g"), target);
    const wrappedPattern = source.trim().split(/\s+/).map(escapeRegExp).join("\\s+");
    translated = translated.replace(new RegExp(wrappedPattern, "g"), target);
  }
  const protectedText = protectTechnicalTokens(translated);
  translated = protectedText.masked;
  for (const [source, target] of TURKISH_TRANSLATIONS) {
    if (!/^[A-Za-z]+$/.test(source)) continue;
    translated = translated.replace(new RegExp(`\\b${escapeRegExp(source)}\\b`, "g"), target);
  }
  return values.restore(protectedText.restore(translated));
}

export function hasTurkishTranslation(source: string): boolean {
  return TRANSLATION_LOOKUP.has(source);
}

export const cliTranslationKeys = TURKISH_TRANSLATIONS.map(([source]) => source);
