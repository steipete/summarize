import { parseMessageTemplate, type MessageStyles } from "./message-template.js";
export type { MessageStyles } from "./message-template.js";
import { IntlMessageFormat } from "intl-messageformat";

export const UI_LOCALES = [
  "en",
  "de",
  "fr",
  "es",
  "it",
  "pt-BR",
  "nl",
  "pl",
  "ru",
  "ja",
  "zh-Hans",
  "zh-Hant",
  "ko",
  "tr",
] as const;
export type UiLocale = (typeof UI_LOCALES)[number];
export type LocaleSetting = UiLocale | "auto";
export type MessageValues = {
  [name: string]: string | number | boolean | Date | MessageDescriptor;
};
export type FallbackMessage = { fallback: "en"; reason: string };
/** JSON imports widen literal strings; the loader validates the fallback marker. */
export type Catalog = Readonly<Record<string, string | { fallback: string; reason: string }>>;

/** Shared by browser bindings and the source audit, including accessibility-only copy. */
export const LOCALIZED_ATTRIBUTES = [
  "title",
  "alt",
  "placeholder",
  "label",
  "value",
  "aria-label",
  "aria-description",
  "aria-valuetext",
  "aria-placeholder",
  "aria-roledescription",
  "aria-braillelabel",
  "aria-brailleroledescription",
] as const;

const ALIASES: Record<string, string> = {
  english: "en",
  turkish: "tr",
  turkce: "tr",
  türkçe: "tr",
  deutsch: "de",
  german: "de",
  portuguese: "pt-BR",
  chinese: "zh-Hans",
};

function matchLocale(raw: string): UiLocale | undefined {
  const normalized = raw.trim().replaceAll("_", "-").split(/[.@]/, 1)[0].toLowerCase();
  if (!normalized || normalized === "auto") return undefined;
  if (normalized === "c" || normalized === "posix") return "en";
  const alias = Object.hasOwn(ALIASES, normalized) ? ALIASES[normalized] : undefined;
  if (alias) return alias as UiLocale;
  try {
    const tag = new Intl.Locale(normalized);
    if (tag.language === "zh") return tag.maximize().script === "Hant" ? "zh-Hant" : "zh-Hans";
    if (tag.language === "pt") return "pt-BR";
    return (
      UI_LOCALES.find((locale) => locale.toLowerCase() === normalized) ??
      UI_LOCALES.find((locale) => locale === tag.language)
    );
  } catch {
    return undefined;
  }
}

/** Explicit preference, then ordered platform preferences, then the English base. */
export function negotiateLocale(
  setting?: string | null,
  preferences: readonly string[] = [],
  available: readonly UiLocale[] = UI_LOCALES,
): UiLocale {
  const candidates =
    setting?.trim() && setting.trim().toLowerCase() !== "auto"
      ? [setting, ...preferences]
      : preferences;
  for (const candidate of candidates) {
    const locale = matchLocale(candidate);
    if (locale && available.includes(locale)) return locale;
  }
  return "en";
}

export function normalizeLocaleSetting(raw: unknown): LocaleSetting {
  if (typeof raw !== "string" || raw.trim().toLowerCase() === "auto") return "auto";
  return matchLocale(raw) ?? "auto";
}

export function localeDirection(locale: string): "ltr" | "rtl" {
  const script = new Intl.Locale(locale).maximize().script;
  return script && ["Arab", "Hebr", "Thaa", "Nkoo", "Adlm"].includes(script) ? "rtl" : "ltr";
}

export function isFallbackMessage(value: unknown): value is FallbackMessage {
  return (
    typeof value === "object" &&
    value !== null &&
    "fallback" in value &&
    value.fallback === "en" &&
    "reason" in value &&
    typeof value.reason === "string" &&
    value.reason.trim().length > 0 &&
    Object.keys(value).length === 2
  );
}

/** Each surface supplies one English catalog and its translations to the same loader. */
export function createTranslator<Base extends Readonly<Record<string, string>>>(
  base: Base,
  catalogs: Readonly<Partial<Record<UiLocale, Catalog>>>,
  locale: UiLocale,
  styles: MessageStyles = {},
) {
  const compiled = new Map<keyof Base, { formatter: IntlMessageFormat; styled: boolean }>();
  const render = (key: keyof Base & string, values: MessageValues = {}, depth = 0): string => {
    if (depth > 16) throw new Error("Message nesting exceeds the supported depth");
    if (!Object.hasOwn(base, key)) throw new Error(`Unknown message key: ${key}`);
    let compiledMessage = compiled.get(key);
    if (!compiledMessage) {
      const catalog = catalogs[locale];
      const entry = catalog && Object.hasOwn(catalog, key) ? catalog[key] : undefined;
      if (entry !== undefined && typeof entry !== "string" && !isFallbackMessage(entry))
        throw new Error(`Invalid English fallback marker: ${key}`);
      const translated = typeof entry === "string";
      const parsed = parseMessageTemplate(translated ? entry : base[key]);
      compiledMessage = {
        formatter: new IntlMessageFormat(parsed.ast, translated ? locale : "en"),
        styled: parsed.styled,
      };
      compiled.set(key, compiledMessage);
    }
    const identity = (text: string) => text;
    const result = compiledMessage.formatter.format({
      ...Object.fromEntries(
        Object.entries(values).map(([name, value]) => [
          name,
          typeof value === "object" && !(value instanceof Date)
            ? render(value.key, value.values, depth + 1)
            : value,
        ]),
      ),
      uiLabel: (chunks) => (styles.uiLabel ?? identity)(chunks.join("")),
      uiDetail: (chunks) => (styles.uiDetail ?? identity)(chunks.join("")),
      uiValue: (chunks) => (styles.uiValue ?? identity)(chunks.join("")),
    });
    if (typeof result !== "string") throw new Error(`Message must render as text: ${key}`);
    return !compiledMessage.styled && styles.default ? styles.default(result) : result;
  };
  return (key: keyof Base & string, values: MessageValues = {}): string => render(key, values);
}

/** Parameter names and value types for validating optional message descriptors on the wire. */
export function messageParameters(
  template: string,
): ReadonlyMap<string, ReadonlySet<"value" | "number" | "date" | "select">> {
  const { ast } = parseMessageTemplate(template);
  const parameters = new Map<string, Set<"value" | "number" | "date" | "select">>();
  const visit = (nodes: typeof ast) => {
    for (const node of nodes) {
      if (node.type === 0 || node.type === 7) continue;
      if (node.type === 8) {
        visit(node.children);
        continue;
      }
      const types = parameters.get(node.value) ?? new Set<"value" | "number" | "date" | "select">();
      types.add(
        node.type === 2 || node.type === 6
          ? "number"
          : node.type === 3 || node.type === 4
            ? "date"
            : node.type === 5
              ? "select"
              : "value",
      );
      parameters.set(node.value, types);
      if (node.type === 5 || node.type === 6)
        for (const option of Object.values(node.options)) visit(option.value);
    }
  };
  visit(ast);
  return parameters;
}

export type MessageDescriptor = { key: string; values: MessageValues };
