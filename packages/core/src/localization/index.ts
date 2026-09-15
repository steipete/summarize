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
export type MessageValues = Record<string, string | number | boolean | Date>;
export type FallbackMessage = { fallback: "en"; reason: string };
export type Catalog = Readonly<Record<string, string | FallbackMessage>>;

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
  const alias = ALIASES[normalized];
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
) {
  const compiled = new Map<keyof Base, IntlMessageFormat>();
  return (key: keyof Base & string, values: MessageValues = {}): string => {
    if (!Object.hasOwn(base, key)) throw new Error(`Unknown message key: ${key}`);
    let formatter = compiled.get(key);
    if (!formatter) {
      const catalog = catalogs[locale];
      const entry = catalog && Object.hasOwn(catalog, key) ? catalog[key] : undefined;
      const translated = typeof entry === "string";
      formatter = new IntlMessageFormat(
        translated ? entry : base[key],
        translated ? locale : "en",
        undefined,
        { ignoreTag: true },
      );
      compiled.set(key, formatter);
    }
    const result = formatter.format(values);
    if (typeof result !== "string") throw new Error(`Message must render as text: ${key}`);
    return result;
  };
}
