import de from "./catalogs/de.json" with { type: "json" };
import en from "./catalogs/en.json" with { type: "json" };
import es from "./catalogs/es.json" with { type: "json" };
import fr from "./catalogs/fr.json" with { type: "json" };
import it from "./catalogs/it.json" with { type: "json" };
import ja from "./catalogs/ja.json" with { type: "json" };
import ko from "./catalogs/ko.json" with { type: "json" };
import nl from "./catalogs/nl.json" with { type: "json" };
import pl from "./catalogs/pl.json" with { type: "json" };
import ptBR from "./catalogs/pt-BR.json" with { type: "json" };
import ru from "./catalogs/ru.json" with { type: "json" };
import tr from "./catalogs/tr.json" with { type: "json" };
import zhHans from "./catalogs/zh-Hans.json" with { type: "json" };
import zhHant from "./catalogs/zh-Hant.json" with { type: "json" };
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
export const sharedMessageCatalogs = {
  en,
  de,
  fr,
  es,
  it,
  "pt-BR": ptBR,
  nl,
  pl,
  ru,
  ja,
  "zh-Hans": zhHans,
  "zh-Hant": zhHant,
  ko,
  tr,
};
export type RegisteredUiLocale = keyof typeof sharedMessageCatalogs;
export const availableUiLocales = Object.keys(sharedMessageCatalogs) as UiLocale[];
