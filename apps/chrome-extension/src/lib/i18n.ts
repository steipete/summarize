import englishMessages from "../localization/en.json" with { type: "json" };
import turkishMessages from "../localization/tr.json" with { type: "json" };
export type ExtensionLocale = "en" | "tr";
export type ExtensionLocaleSetting = "auto" | ExtensionLocale;

const TURKISH: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(englishMessages).map(([key, source]) => [
    source,
    turkishMessages[key as keyof typeof turkishMessages],
  ]),
);

export function resolveExtensionLocale(
  setting: ExtensionLocaleSetting = "auto",
  browserLanguage = typeof navigator === "undefined" ? "" : navigator.language,
): ExtensionLocale {
  if (setting === "tr" || setting === "en") return setting;
  return browserLanguage.toLowerCase().startsWith("tr") ? "tr" : "en";
}

export function translateExtensionText(text: string, locale: ExtensionLocale): string {
  if (locale === "en") return text;
  const leading = text.match(/^\s*/)?.[0] ?? "";
  const trailing = text.match(/\s*$/)?.[0] ?? "";
  const normalized = text.trim().replaceAll(/\s+/g, " ");
  const exact = Object.hasOwn(TURKISH, text)
    ? TURKISH[text]
    : Object.hasOwn(TURKISH, normalized)
      ? TURKISH[normalized]
      : undefined;
  if (exact) return `${leading}${exact}${trailing}`;
  const source = text.trim();
  let translated: string | null = null;
  if (source.startsWith("Page · ")) {
    translated = `Sayfa · ${source.slice("Page · ".length).replace(/(\d+) words$/, "$1 kelime")}`;
  } else if (source.startsWith("Context ")) {
    const context = source.match(/^Context (.+?)% · (.+?) msgs · (.+?) chars$/);
    translated = context
      ? `Bağlam ${context[1]}% · ${context[2]} mesaj · ${context[3]} karakter`
      : `Bağlam ${source.slice("Context ".length)}`;
  } else if (source.startsWith("Running: ")) {
    translated = `Çalışıyor: ${source.slice("Running: ".length)}`;
  } else if (source.startsWith("Failed to load skills: ")) {
    translated = `Yetenekler yüklenemedi: ${source.slice("Failed to load skills: ".length)}`;
  } else if (source.startsWith("Edit skill: ")) {
    translated = `Yeteneği düzenle: ${source.slice("Edit skill: ".length)}`;
  } else if (source.startsWith('Delete skill "') && source.endsWith('"?')) {
    translated = `"${source.slice('Delete skill "'.length, -2)}" yeteneği silinsin mi?`;
  } else if (source.startsWith("Delete skill: ")) {
    translated = `Yeteneği sil: ${source.slice("Delete skill: ".length)}`;
  } else if (source.startsWith("Daemon error (")) {
    translated = `Daemon hatası (${source.slice("Daemon error (".length)}`;
  } else if (source.startsWith("Daemon ") && source.endsWith(" connected")) {
    translated = `Daemon ${source.slice("Daemon ".length, -" connected".length)} bağlandı`;
  } else if (source.startsWith("Daemon ") && source.includes(" (token mismatch) — ")) {
    translated = source.replace(
      " (token mismatch) — update token in side panel and Save",
      " (token uyuşmazlığı) — yan panelde token'ı güncelleyin ve Kaydet'e tıklayın",
    );
  } else if (source.startsWith("Daemon ") && source.includes(" (auth failed) — ")) {
    translated = source.replace(
      " (auth failed) — update token in side panel and Save",
      " (kimlik doğrulama başarısız) — yan panelde token'ı güncelleyin ve Kaydet'e tıklayın",
    );
  } else if (source.startsWith("Slides (") && source.includes(") · showing ")) {
    translated = source
      .replace(/^Slides \(/, "Slaytlar (")
      .replace(") · showing ", ") · gösterilen ");
  } else if (source.startsWith("Slides (")) {
    translated = `Slaytlar ${source.slice("Slides ".length)}`;
  } else if (source.startsWith("Slide ")) {
    translated = `Slayt ${source.slice("Slide ".length)}`;
  } else if (source.startsWith("Logs · ")) {
    translated = `Günlükler · ${source.slice("Logs · ".length)}`;
  } else if (/^\d+ words$/.test(source)) {
    translated = `${source.slice(0, -" words".length)} kelime`;
  } else if (/^\d+ entries · /.test(source)) {
    translated = source.replace(" entries · ", " girdi · ");
  } else if (/^\d+ processes$/.test(source)) {
    translated = source.replace(" processes", " işlem");
  } else if (/^Imported \d+ skill\(s\)\.$/.test(source)) {
    translated = source.replace(/^Imported (\d+) skill\(s\)\.$/, "$1 yetenek içe aktarıldı.");
  } else if (/^Queue full \(\d+\)\. Remove one to add more\.$/.test(source)) {
    translated = source.replace(
      /^Queue full \((\d+)\)\. Remove one to add more\.$/,
      "Kuyruk dolu ($1). Daha fazla eklemek için birini kaldırın.",
    );
  } else if (/^Tool result: /.test(source)) {
    translated = source.replace(/^Tool result:/, "Araç sonucu:").replace(" (error)", " (hata)");
  } else if (/^Error: /.test(source)) {
    translated = source.replace(/^Error:/, "Hata:");
  } else if (/^1\) Install summarize \(/.test(source)) {
    translated = source.replace(/^1\) Install summarize/, "1) summarize'ı kur");
  } else if (/^2\) Register the daemon \(/.test(source)) {
    translated = source.replace(/^2\) Register the daemon/, "2) Daemon'u kaydet");
  } else if (/^Chrome \d+ detected\./.test(source)) {
    translated = source
      .replace(/^Chrome (\d+) detected\./, "Chrome $1 algılandı.")
      .replace("To enable User Scripts:", "User Scripts'i etkinleştirmek için:")
      .replace("Go to", "Şuraya gidin:")
      .replace("Find this extension and click", "Bu uzantıyı bulun ve tıklayın")
      .replace("Enable the", "Şunu etkinleştirin:")
      .replace("toggle", "anahtarı")
      .replace("Reload the page and try again", "Sayfayı yeniden yükleyip tekrar deneyin")
      .replace("Enable Developer mode in", "Şurada Geliştirici modunu etkinleştirin:")
      .replace(
        "then reload the extension and try again",
        "ardından uzantıyı yeniden yükleyip tekrar deneyin",
      )
      .replace(
        "The userScripts API requires Chrome 120 or higher. Please update Chrome.",
        "userScripts API'si Chrome 120 veya üzerini gerektirir. Lütfen Chrome'u güncelleyin.",
      );
  } else if (source === "just now") {
    translated = "şimdi";
  } else if (/^\d+[smhd] ago$/.test(source)) {
    translated = source.replace(/^(\d+)([smhd]) ago$/, (_, value: string, unit: string) => {
      const units: Record<string, string> = { s: "saniye", m: "dakika", h: "saat", d: "gün" };
      return `${value} ${units[unit] ?? unit} önce`;
    });
  } else if (/^size .+ · updated .+/.test(source)) {
    translated = source
      .replace(/^size /, "boyut ")
      .replace(" · updated ", " · güncellendi ")
      .replace(" · tail truncated", " · kuyruk kısaltıldı");
  } else if (/^size /.test(source)) {
    translated = source
      .replace(/^size /, "boyut ")
      .replace(" · tail truncated", " · kuyruk kısaltıldı");
  } else if (/^updated /.test(source)) {
    translated = source
      .replace(/^updated /, "güncellendi ")
      .replace(" · tail truncated", " · kuyruk kısaltıldı");
  }
  return translated == null ? text : `${leading}${translated}${trailing}`;
}

const TRANSLATABLE_ATTRIBUTES = ["aria-label", "title", "placeholder"] as const;
let activeObserver: MutationObserver | null = null;
let activeLocale: ExtensionLocale = "en";
const originalText = new WeakMap<Text, string>();
const lastTranslatedText = new WeakMap<Text, string>();
const originalAttributes = new WeakMap<Element, Map<string, string>>();
const lastTranslatedAttributes = new WeakMap<Element, Map<string, string>>();

function isApplicationUi(node: Node): boolean {
  const element = node instanceof Element ? node : node.parentElement;
  return Boolean(
    element?.closest("[data-locale-ui]") &&
    !element.closest("code, pre, script, style, [data-locale-ignore]"),
  );
}

/** Apply the selected locale to static HTML and to later-rendered extension UI nodes. */
export function applyExtensionLocale(locale: ExtensionLocale): () => void {
  activeObserver?.disconnect();
  activeLocale = locale;
  document.documentElement.lang = locale;
  const translateTextNode = (textNode: Text) => {
    const current = textNode.nodeValue ?? "";
    if (!current.trim() || !isApplicationUi(textNode)) return;
    const source = originalText.get(textNode);
    const lastTranslated = lastTranslatedText.get(textNode);
    const resolvedSource =
      source === undefined ||
      (lastTranslated !== undefined && current !== lastTranslated && current !== source)
        ? current
        : (source ?? current);
    originalText.set(textNode, resolvedSource);
    const translated = translateExtensionText(resolvedSource, locale);
    if (current !== translated) textNode.nodeValue = translated;
    lastTranslatedText.set(textNode, translated);
  };
  const translateElementAttributes = (element: Element) => {
    if (!isApplicationUi(element)) return;
    for (const attribute of TRANSLATABLE_ATTRIBUTES) {
      const value = element.getAttribute(attribute);
      if (!value) continue;
      const sources = originalAttributes.get(element) ?? new Map<string, string>();
      const lastTranslated = lastTranslatedAttributes.get(element)?.get(attribute);
      const source = sources.get(attribute);
      const resolvedSource =
        source === undefined ||
        (lastTranslated !== undefined && value !== lastTranslated && value !== source)
          ? value
          : (source ?? value);
      sources.set(attribute, resolvedSource);
      originalAttributes.set(element, sources);
      const translated = translateExtensionText(resolvedSource, locale);
      if (value !== translated) element.setAttribute(attribute, translated);
      const translatedValues = lastTranslatedAttributes.get(element) ?? new Map<string, string>();
      translatedValues.set(attribute, translated);
      lastTranslatedAttributes.set(element, translatedValues);
    }
  };
  const translate = (root: ParentNode) => {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const textNodes: Text[] = [];
    let node: Node | null;
    while ((node = walker.nextNode())) {
      if (node.nodeValue?.trim() && isApplicationUi(node)) textNodes.push(node as Text);
    }
    for (const textNode of textNodes) translateTextNode(textNode);

    if (root instanceof Element) translateElementAttributes(root);
    for (const element of root.querySelectorAll("*")) {
      translateElementAttributes(element);
    }
  };

  translate(document);
  const observer = new MutationObserver((records) => {
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (node.nodeType === Node.ELEMENT_NODE) translate(node as Element);
        else if (node.nodeType === Node.TEXT_NODE) translateTextNode(node as Text);
      }
      if (record.type === "characterData" && record.target.nodeType === Node.TEXT_NODE) {
        translateTextNode(record.target as Text);
      }
      if (record.type === "attributes" && record.target.nodeType === Node.ELEMENT_NODE) {
        translateElementAttributes(record.target as Element);
      }
    }
  });
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
    attributeFilter: [...TRANSLATABLE_ATTRIBUTES],
  });
  activeObserver = observer;
  return () => observer.disconnect();
}

export const extensionTranslationKeys = Object.keys(TURKISH);

export function getActiveExtensionLocale(): ExtensionLocale {
  return activeLocale;
}
