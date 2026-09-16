import {
  createTranslator,
  messageParameters,
  LOCALIZED_ATTRIBUTES,
  localeDirection,
  negotiateLocale,
  type LocaleSetting,
  type MessageValues,
  type UiLocale,
  type Catalog,
  type MessageDescriptor,
} from "@steipete/summarize-core/localization";
import {
  sharedEnglishMessages,
  sharedMessageCatalogs,
  availableUiLocales,
  type RegisteredUiLocale,
} from "@steipete/summarize-core/localization/messages";
import ownEnglish from "../localization/en.json";
import ownTurkish from "../localization/tr.json";
const english = { ...sharedEnglishMessages, ...ownEnglish };
const turkish = { ...sharedMessageCatalogs.tr, ...ownTurkish };

export type ExtensionLocale = UiLocale;
export type ExtensionLocaleSetting = LocaleSetting;
export type ExtensionMessageKey = keyof typeof english;
export type MessageValuesSource = MessageValues | (() => MessageValues);
export type LocalizedMessage = { key: ExtensionMessageKey; values: MessageValuesSource };
export type LocalizedDescriptor = { key: ExtensionMessageKey; values: MessageValues };
export type LocalizedText = string | LocalizedMessage;

const catalogs = { en: english, tr: turkish } satisfies Record<RegisteredUiLocale, Catalog>;
const translators = new Map<ExtensionLocale, ReturnType<typeof createTranslator<typeof english>>>();
let activeLocale: ExtensionLocale = "en";
let observer: MutationObserver | null = null;
const valuesByElement = new WeakMap<Element, Map<string, LocalizedMessage>>();
const listeners = new Set<() => void>();
const attributes = LOCALIZED_ATTRIBUTES;

export function resolveExtensionLocale(
  setting: string = "auto",
  browserLanguages: string | readonly string[] = typeof navigator === "undefined"
    ? []
    : navigator.languages,
): ExtensionLocale {
  return negotiateLocale(
    setting,
    typeof browserLanguages === "string" ? [browserLanguages] : browserLanguages,
    availableUiLocales,
  );
}

export function extensionMessage(
  key: ExtensionMessageKey,
  values: MessageValues = {},
  locale = activeLocale,
): string {
  let translate = translators.get(locale);
  if (!translate) {
    translate = createTranslator(english, catalogs, locale);
    translators.set(locale, translate);
  }
  return translate(key, values);
}

export function message(key: ExtensionMessageKey, values?: MessageValues): LocalizedDescriptor;
export function message(key: ExtensionMessageKey, values: MessageValuesSource): LocalizedMessage;
export function message(
  key: ExtensionMessageKey,
  values: MessageValuesSource = {},
): LocalizedMessage {
  return { key, values };
}

export function resolveText(value: LocalizedText, locale = activeLocale): string {
  return typeof value === "string"
    ? value
    : extensionMessage(
        value.key,
        typeof value.values === "function" ? value.values() : value.values,
        locale,
      );
}

/** Owned errors retain their descriptor across catches; native/provider diagnostics remain text. */
export class LocalizedError extends Error {
  constructor(
    readonly localized: LocalizedDescriptor,
    options?: ErrorOptions,
  ) {
    super(resolveText(localized, "en"), options);
  }
}

export function localizedErrorText(error: unknown): string | LocalizedDescriptor {
  return error instanceof LocalizedError
    ? error.localized
    : error instanceof Error
      ? error.message
      : String(error);
}

/** Bind the key, not rendered words, so a locale change can redraw without touching user content. */
export function setText(element: Element, value: LocalizedText): void {
  if (typeof value === "string") {
    element.removeAttribute("data-i18n");
    valuesByElement.get(element)?.delete("text");
    element.textContent = value;
    return;
  }
  element.setAttribute("data-i18n", value.key);
  const values = valuesByElement.get(element) ?? new Map<string, LocalizedMessage>();
  values.set("text", value);
  valuesByElement.set(element, values);
  element.textContent = resolveText(value);
}

export function setLocalizedAttribute(
  element: Element,
  attribute: (typeof attributes)[number],
  value: LocalizedText,
): void {
  if (typeof value === "string") {
    element.removeAttribute(`data-i18n-${attribute}`);
    valuesByElement.get(element)?.delete(attribute);
    element.setAttribute(attribute, value);
    return;
  }
  element.setAttribute(`data-i18n-${attribute}`, value.key);
  const values = valuesByElement.get(element) ?? new Map<string, LocalizedMessage>();
  values.set(attribute, value);
  valuesByElement.set(element, values);
  element.setAttribute(attribute, resolveText(value));
}

function renderElement(element: Element): void {
  if (element.closest("script, style")) return;
  const ignoredContent = Boolean(element.closest("[data-locale-ignore]"));
  for (const attribute of ["text", ...attributes]) {
    const key = element.getAttribute(attribute === "text" ? "data-i18n" : `data-i18n-${attribute}`);
    if (!key || !Object.hasOwn(english, key)) continue;
    const binding = valuesByElement.get(element)?.get(attribute);
    if (ignoredContent && binding?.key !== key) continue;
    let source = binding?.key === key ? binding.values : undefined;
    const serialized = element.getAttribute("data-i18n-values");
    if (!source && serialized) {
      try {
        const decoded = readLocalizedMessage({ key, values: JSON.parse(serialized) });
        if (!decoded) continue;
        source = decoded.values;
      } catch {
        continue;
      }
    }
    const text = extensionMessage(
      key as ExtensionMessageKey,
      typeof source === "function" ? source() : source,
    );
    if (attribute === "text") {
      if (element.textContent !== text) element.textContent = text;
    } else if (element.getAttribute(attribute) !== text) element.setAttribute(attribute, text);
  }
}

const selector = ["[data-i18n]", ...attributes.map((attribute) => `[data-i18n-${attribute}]`)].join(
  ",",
);
function renderTree(root: ParentNode): void {
  if (root instanceof Element) renderElement(root);
  for (const element of root.querySelectorAll(selector)) renderElement(element);
}

export function applyExtensionLocale(locale: ExtensionLocale): () => void {
  observer?.disconnect();
  activeLocale = locale;
  document.documentElement.lang = locale;
  document.documentElement.dir = localeDirection(locale);
  renderTree(document);
  for (const listener of listeners) listener();
  const currentObserver = new MutationObserver((records) => {
    for (const record of records) {
      if (record.type === "attributes") renderElement(record.target as Element);
      for (const node of record.addedNodes) if (node instanceof Element) renderTree(node);
    }
  });
  currentObserver.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: [
      "data-i18n",
      "data-i18n-values",
      ...attributes.map((attribute) => `data-i18n-${attribute}`),
    ],
  });
  observer = currentObserver;
  return () => currentObserver.disconnect();
}

export function subscribeLocale(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getActiveExtensionLocale(): ExtensionLocale {
  return activeLocale;
}

export function uiNumber(value: number, options: Intl.NumberFormatOptions = {}): string {
  return new Intl.NumberFormat(activeLocale, options).format(value);
}
export function uiDate(
  value: number | Date,
  options: Intl.DateTimeFormatOptions = { dateStyle: "medium", timeStyle: "short" },
): string {
  return new Intl.DateTimeFormat(activeLocale, options).format(value);
}
export function uiRelativeTime(value: number, unit: Intl.RelativeTimeFormatUnit): string {
  return new Intl.RelativeTimeFormat(activeLocale, { numeric: "auto", style: "short" }).format(
    value,
    unit,
  );
}

const parameterCache = new Map<string, ReturnType<typeof messageParameters>>();
export function readLocalizedMessage(
  raw: unknown,
  depth = 0,
): (MessageDescriptor & { key: ExtensionMessageKey }) | undefined {
  if (
    depth > 16 ||
    !raw ||
    typeof raw !== "object" ||
    !("key" in raw) ||
    typeof raw.key !== "string" ||
    !Object.hasOwn(english, raw.key) ||
    !("values" in raw)
  )
    return undefined;
  const values = raw.values;
  if (!values || typeof values !== "object" || Array.isArray(values)) return undefined;
  if (
    Object.values(values).some(
      (value) =>
        (!["string", "number", "boolean"].includes(typeof value) &&
          !readLocalizedMessage(value, depth + 1)) ||
        (typeof value === "number" && !Number.isFinite(value)),
    )
  )
    return undefined;
  const key = raw.key as ExtensionMessageKey;
  let parameters = parameterCache.get(key);
  if (!parameters) {
    parameters = messageParameters(english[key]);
    parameterCache.set(key, parameters);
  }
  for (const [name, types] of parameters) {
    if (!Object.hasOwn(values, name)) return undefined;
    const value = (values as MessageValues)[name];
    if ((types.has("number") || types.has("date")) && typeof value !== "number") return undefined;
    if (types.has("select") && typeof value === "object") return undefined;
  }
  return { key, values: values as MessageValues };
}

export function escapeUiHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/** For existing HTML template renderers. Catalogs and arguments always render as text. */
export function localizedHtml(value: LocalizedText): string {
  if (typeof value === "string") return escapeUiHtml(value);
  const source = typeof value.values === "function" ? value.values() : value.values;
  const values = Object.fromEntries(
    Object.entries(source).map(([key, value]) => [
      key,
      value instanceof Date ? value.getTime() : value,
    ]),
  );
  return `<span data-i18n="${escapeUiHtml(value.key)}" data-i18n-values="${escapeUiHtml(JSON.stringify(values))}">${escapeUiHtml(resolveText(value))}</span>`;
}
