import en from "./catalogs/en.json" with { type: "json" };
import tr from "./catalogs/tr.json" with { type: "json" };
import type { UiLocale, MessageValues } from "./index.js";

/** Wire messages have one canonical translation shared by CLI and browser renderers. */
export const sharedEnglishMessages = en;
export type SharedMessage = { key: keyof typeof sharedEnglishMessages; values: MessageValues };
export function sharedMessage(
  key: SharedMessage["key"],
  values: MessageValues = {},
): SharedMessage {
  return { key, values };
}
export const sharedMessageCatalogs = { en, tr };
export type RegisteredUiLocale = keyof typeof sharedMessageCatalogs;
export const availableUiLocales = Object.keys(sharedMessageCatalogs) as UiLocale[];
