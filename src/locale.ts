import {
  createTranslator,
  negotiateLocale,
  type UiLocale,
  type MessageStyles,
  type Catalog,
} from "@steipete/summarize-core/localization";
import {
  sharedEnglishMessages,
  sharedMessageCatalogs,
  availableUiLocales,
  type RegisteredUiLocale,
} from "@steipete/summarize-core/localization/messages";
import deMessages from "./localization/de.json" with { type: "json" };
import englishMessages from "./localization/en.json" with { type: "json" };
import esMessages from "./localization/es.json" with { type: "json" };
import frMessages from "./localization/fr.json" with { type: "json" };
import itMessages from "./localization/it.json" with { type: "json" };
import jaMessages from "./localization/ja.json" with { type: "json" };
import koMessages from "./localization/ko.json" with { type: "json" };
import nlMessages from "./localization/nl.json" with { type: "json" };
import plMessages from "./localization/pl.json" with { type: "json" };
import ptBRMessages from "./localization/pt-BR.json" with { type: "json" };
import ruMessages from "./localization/ru.json" with { type: "json" };
import turkishMessages from "./localization/tr.json" with { type: "json" };
import zhHansMessages from "./localization/zh-Hans.json" with { type: "json" };
import zhHantMessages from "./localization/zh-Hant.json" with { type: "json" };

/** UI locale is independent of --language, which controls generated summaries. */
export type CliLocale = UiLocale;
const english = { ...sharedEnglishMessages, ...englishMessages };
const catalogs = {
  en: english,
  tr: { ...sharedMessageCatalogs.tr, ...turkishMessages },
  de: { ...sharedMessageCatalogs["de"], ...deMessages },
  fr: { ...sharedMessageCatalogs["fr"], ...frMessages },
  es: { ...sharedMessageCatalogs["es"], ...esMessages },
  it: { ...sharedMessageCatalogs["it"], ...itMessages },
  "pt-BR": { ...sharedMessageCatalogs["pt-BR"], ...ptBRMessages },
  nl: { ...sharedMessageCatalogs["nl"], ...nlMessages },
  pl: { ...sharedMessageCatalogs["pl"], ...plMessages },
  ru: { ...sharedMessageCatalogs["ru"], ...ruMessages },
  ja: { ...sharedMessageCatalogs["ja"], ...jaMessages },
  "zh-Hans": { ...sharedMessageCatalogs["zh-Hans"], ...zhHansMessages },
  "zh-Hant": { ...sharedMessageCatalogs["zh-Hant"], ...zhHantMessages },
  ko: { ...sharedMessageCatalogs["ko"], ...koMessages },
} satisfies Record<RegisteredUiLocale, Catalog>;
export type CliMessageKey = keyof typeof english;

const plainTranslators = new Map<CliLocale, ReturnType<typeof createTranslator<typeof english>>>();
export function createCliTranslator(locale: CliLocale, styles?: MessageStyles) {
  if (styles) return createTranslator(english, catalogs, locale, styles);
  let translator = plainTranslators.get(locale);
  if (!translator) {
    translator = createTranslator(english, catalogs, locale);
    plainTranslators.set(locale, translator);
  }
  return translator;
}

export function resolveCliLocale(raw: string | null | undefined): CliLocale {
  return negotiateLocale(raw, [], availableUiLocales);
}

export function resolveCliLocaleFromEnv(
  env: Record<string, string | undefined>,
  explicit?: string | null,
): CliLocale {
  const platform = env.LC_ALL?.trim() || env.LC_MESSAGES?.trim() || env.LANG?.trim();
  return negotiateLocale(
    explicit?.trim() || env.SUMMARIZE_LOCALE,
    [platform || new Intl.DateTimeFormat().resolvedOptions().locale],
    availableUiLocales,
  );
}

export function resolveCliLocaleFromArgs(
  argv: readonly string[],
  env: Record<string, string | undefined>,
): CliLocale {
  let explicit: string | undefined;
  for (let index = 0; index < argv.length && argv[index] !== "--"; index += 1) {
    const argument = argv[index];
    if (argument.startsWith("--locale=")) explicit = argument.slice("--locale=".length);
    else if (argument === "--locale") explicit = argv[++index];
  }
  return resolveCliLocaleFromEnv(env, explicit);
}

export type CliMessage = {
  key: CliMessageKey;
  values: import("@steipete/summarize-core/localization").MessageValues;
};
export function cliMessage(key: CliMessageKey, values: CliMessage["values"] = {}): CliMessage {
  return { key, values };
}
export type CliProgressCallback = (text: string, message?: CliMessage) => void;

/** The text field keeps existing progress consumers working; new UIs render the descriptor. */
export function emitCliMessage(
  callback: CliProgressCallback | null | undefined,
  locale: CliLocale,
  key: CliMessageKey,
  values: CliMessage["values"] = {},
): void {
  callback?.(createCliTranslator(locale)(key, values), { key, values });
}

/** Keep stable English diagnostics for APIs; translate owned errors only at the CLI boundary. */
export class CliError extends Error {
  readonly #key: CliMessageKey;
  readonly #values: CliMessage["values"];

  constructor(key: CliMessageKey, values: CliMessage["values"] = {}, options?: ErrorOptions) {
    super(createCliTranslator("en")(key, values), options);
    this.#key = key;
    this.#values = values;
    Error.captureStackTrace?.(this, CliError);
  }

  descriptor(): CliMessage {
    return {
      key: this.#key,
      values: this.#values,
    };
  }

  format(locale: CliLocale): string {
    const message = this.descriptor();
    return createCliTranslator(locale)(message.key, message.values);
  }
}

export function cliErrorText(error: unknown, locale: CliLocale): string {
  if (error instanceof CliError) return error.format(locale);
  return error instanceof Error
    ? error.message
    : error
      ? String(error)
      : createCliTranslator(locale)("error.unknown");
}

/** Preserve the English wire diagnostic while giving clients a validated localization descriptor. */
export function describeCliError(error: unknown) {
  return {
    message: error instanceof Error ? error.message : String(error),
    ...(error instanceof CliError ? { localized: error.descriptor() } : {}),
  };
}
