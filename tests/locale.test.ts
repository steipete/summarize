// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from "vitest";
import {
  applyExtensionLocale,
  getActiveExtensionLocale,
  resolveExtensionLocale,
  extensionMessage,
  message,
  readLocalizedMessage,
  setText,
  setLocalizedAttribute,
} from "../apps/chrome-extension/src/lib/i18n.js";
import {
  createCliTranslator,
  CliError,
  describeCliError,
  resolveCliLocale,
  resolveCliLocaleFromArgs,
  resolveCliLocaleFromEnv,
} from "../src/locale.js";
import englishMessages from "../src/localization/en.json";
import { withBirdTip } from "../src/run/bird.js";
import { withUvxTip } from "../src/run/tips.js";

describe("CLI locale selection and keyed messages", () => {
  it("keeps nested owned errors locale-neutral across the daemon wire", () => {
    const inner = new CliError("error.preprocessMissing", { mediaType: "application/pdf" });
    for (const wrapped of [
      withUvxTip(inner, { PATH: "" }),
      withBirdTip(inner, "https://x.com/example/status/123", { PATH: "" }),
    ]) {
      const wire = JSON.parse(JSON.stringify(describeCliError(wrapped)));
      expect(wire.message).toContain("Missing uvx/markitdown");
      const descriptor = readLocalizedMessage(wire.localized)!;
      expect(descriptor.values.message).toEqual(inner.descriptor());
      const rendered = extensionMessage(descriptor.key, descriptor.values, "tr");
      expect(rendered).toContain("application/pdf ön işlemesi için uvx/markitdown eksik.");
      expect(rendered).toContain("İpucu:");
      expect(rendered).not.toContain("Missing");
      expect((wrapped as CliError).format("tr")).toBe(rendered);
    }
  });
  it("uses explicit preferences, regional fallbacks, and then the system locale", () => {
    expect(resolveCliLocale("tr-TR")).toBe("tr");
    expect(resolveCliLocale("turkish")).toBe("tr");
    expect(resolveCliLocale("fr")).toBe("fr");
    expect(resolveCliLocale("zh-TW")).toBe("zh-Hant");
    expect(resolveCliLocale("pt-PT")).toBe("pt-BR");
    expect(resolveCliLocale("unknown")).toBe("en");
    expect(resolveCliLocaleFromEnv({ SUMMARIZE_LOCALE: "tr_TR.UTF-8", LANG: "de_DE.UTF-8" })).toBe(
      "tr",
    );
    expect(resolveCliLocaleFromEnv({ LANG: "tr_TR.UTF-8" })).toBe("tr");
    expect(
      resolveCliLocaleFromEnv({ LANG: "de_DE.UTF-8", LC_MESSAGES: "ja_JP.UTF-8", LC_ALL: "C" }),
    ).toBe("en");
    expect(resolveCliLocaleFromEnv({ SUMMARIZE_LOCALE: "tr", LANG: "de_DE.UTF-8" }, "auto")).toBe(
      "de",
    );
    expect(resolveCliLocaleFromArgs(["--locale", "tr"], {})).toBe("tr");
    expect(resolveCliLocaleFromArgs(["--locale=tr", "--locale=en"], {})).toBe("en");
    expect(resolveCliLocaleFromArgs(["--", "--locale=tr"], {})).toBe("en");
    expect(resolveCliLocaleFromArgs(["--locale", "tr", "--", "--locale=en"], {})).toBe("tr");
  });

  it.each([
    ["de", "Beispiele:", "Zusammenfassung kopieren"],
    ["fr", "Exemples :", "Copier le résumé"],
    ["es", "Ejemplos:", "Copiar resumen"],
    ["it", "Esempi:", "Copia riassunto"],
    ["pt-BR", "Exemplos:", "Copiar resumo"],
    ["nl", "Voorbeelden:", "Samenvatting kopiëren"],
    ["pl", "Przykłady:", "Kopiuj podsumowanie"],
    ["ru", "Примеры:", "Копировать сводку"],
    ["ja", "使用例:", "要約をコピー"],
    ["zh-Hans", "示例：", "复制摘要"],
    ["zh-Hant", "範例：", "複製摘要"],
    ["ko", "예제:", "요약 복사"],
  ] as const)("loads complete CLI and extension catalogs for %s", (locale, examples, copy) => {
    expect(resolveCliLocale(locale)).toBe(locale);
    expect(resolveExtensionLocale(locale, "en-US")).toBe(locale);
    expect(createCliTranslator(locale)("help.examples")).toBe(examples);
    expect(extensionMessage("copy.summary", {}, locale)).toBe(copy);
  });

  it("translates complete messages while retaining command and provider identifiers", () => {
    const t = createCliTranslator("tr");
    expect(t("x.fetching.via.syndication.api")).toBe("X: Syndication API üzerinden alınıyor…");
    expect(t("x.syndication.failed.fallback")).toBe(
      "X: Syndication başarısız; alternatif deneniyor…",
    );
    expect(t("status.model", { model: "openai/gpt-5-mini", source: "config" })).toBe(
      "Model: openai/gpt-5-mini (yapılandırma)",
    );
    expect(t("help.usage.summarize.input.flags")).toBe("Kullanım: summarize <input> [flags]");
    expect(t("fetching.website")).toBe("Web sitesi alınıyor");
    expect(createCliTranslator("en")("fetching.website")).toBe("Fetching website");
    expect(Object.keys(englishMessages).length).toBeGreaterThan(30);
  });

  it.each([
    "/home/me/Copy failed/slide.png",
    "C:\\Users\\me\\Copy failed\\slide.png",
    "./Copy failed/slide.png",
    "cache/result.json",
    "Copy failed/slide.png",
    "Loading cache/slide.png",
    "cache.json",
    "Copy failed.txt",
    "/home/me/Projects (old)/config.json",
    "/home/me/Projects, old;/config.json",
    "https://example.com/Copy%20failed/slide.png",
    "{count, plural, other {not a message}}",
  ])("keeps interpolated data verbatim: %s", (path) => {
    const t = createCliTranslator("tr");
    expect(t("slides.image", { index: 3, timestamp: "1:23", path })).toBe(
      `Slayt 3 · 1:23 (${path})`,
    );
    expect(t("refresh.wroteConfig", { path })).toBe(`Yazıldı: ${path} (models.free)`);
  });

  it("preserves raw diagnostics and literal command placeholders", () => {
    const t = createCliTranslator("tr");
    expect(t("warning.detail", { message: 'Copy failed: "Copy failed"' })).toBe(
      'Uyarı: Copy failed: "Copy failed"',
    );
    const help = t("help.environment", { themes: "aurora, ember, moss, mono" });
    expect(help).toContain("{input}");
    expect(help).toContain("OPENAI_API_KEY");
    expect(help).toContain("aurora, ember, moss, mono");
  });
});

describe("extension locale", () => {
  it("keeps the product name distinct from the translated summarize action", () => {
    expect(extensionMessage("brand.name", {}, "tr")).toBe("Summarize");
    expect(extensionMessage("summarize", {}, "tr")).toBe("Özetle");
    expect(extensionMessage("source.summarizeAction", { source: "Video" }, "tr")).toBe(
      "Özetle (Video)",
    );
  });
  afterEach(() => {
    applyExtensionLocale("en")();
    document.body.replaceChildren();
  });

  it.each(["Delete", "Copy failed", 'name with "quotes"'])(
    "localizes deletion confirmations while preserving the skill name: %s",
    (name) => {
      expect(extensionMessage("skills.deleteConfirm", { name }, "tr")).toBe(
        `"${name}" yeteneği silinsin mi?`,
      );
    },
  );

  it("validates descriptors without treating opaque strings as keys", () => {
    const nested = { key: "error.withUvxTip", values: { message: { key: "unknown", values: {} } } };
    expect(readLocalizedMessage(nested)).toBeUndefined();
    const cyclic = { key: "error.withUvxTip", values: {} as Record<string, unknown> };
    cyclic.values.message = cyclic;
    expect(readLocalizedMessage(cyclic)).toBeUndefined();
    for (const key of ["constructor", "toString", "__proto__", "Copy failed"]) {
      expect(readLocalizedMessage({ key, values: {} })).toBeUndefined();
    }
    expect(readLocalizedMessage({ key: "skills.deleteConfirm", values: {} })).toBeUndefined();
    expect(
      readLocalizedMessage({
        key: "chat.context",
        values: { percent: "50", messages: 2, chars: 3 },
      }),
    ).toBeUndefined();
    expect(
      readLocalizedMessage({
        key: "chat.context",
        values: { percent: NaN, messages: 2, chars: 3 },
      }),
    ).toBeUndefined();
    expect(
      readLocalizedMessage({
        key: "chat.context",
        values: { percent: 0.5, messages: 2, chars: 3 },
      }),
    ).toEqual(message("chat.context", { percent: 0.5, messages: 2, chars: 3 }));
  });

  it("uses explicit locale before ordered browser preferences and region fallbacks", () => {
    expect(resolveExtensionLocale("tr", "en-US")).toBe("tr");
    expect(resolveExtensionLocale("en", "tr-TR")).toBe("en");
    expect(resolveExtensionLocale("auto", ["unsupported", "tr-TR"])).toBe("tr");
    expect(resolveExtensionLocale("auto", "fr-FR")).toBe("fr");
    expect(resolveExtensionLocale("auto", "zh-TW")).toBe("zh-Hant");
  });

  it("updates explicit text and attribute bindings while preserving page and user content", async () => {
    document.body.innerHTML = `
      <button id="retry" data-i18n="try.again" data-i18n-title="try.again"></button>
      <div id="dynamic"></div>
      <code id="code" data-i18n-title="try.again">Try again</code>
      <pre id="pre" data-i18n-aria-label="try.again">Try again</pre>
      <input type="button" data-i18n-value="try.again">
      <select><option data-i18n-label="try.again"></option></select>
      <div data-locale-ignore><span data-i18n="try.again">Try again</span><button id="trusted"></button></div>
      <div id="content">Try again</div>`;
    const dynamic = document.querySelector<HTMLElement>("#dynamic")!;
    const trusted = document.querySelector<HTMLElement>("#trusted")!;
    applyExtensionLocale("tr");
    setText(dynamic, message("skills.deleteConfirm", { name: "Try again" }));
    setLocalizedAttribute(dynamic, "title", message("try.again"));
    setText(trusted, message("try.again"));
    expect(getActiveExtensionLocale()).toBe("tr");
    expect(document.querySelector("#code")?.getAttribute("title")).toBe("Tekrar dene");
    expect(document.querySelector("#pre")?.getAttribute("aria-label")).toBe("Tekrar dene");
    expect(document.querySelector("#code")?.textContent).toBe("Try again");
    expect(document.querySelector("#pre")?.textContent).toBe("Try again");
    expect(document.querySelector("#retry")?.textContent).toBe("Tekrar dene");
    expect(document.querySelector("input")?.value).toBe("Tekrar dene");
    expect(document.querySelector("option")?.getAttribute("label")).toBe("Tekrar dene");
    expect(document.querySelector("#retry")?.getAttribute("title")).toBe("Tekrar dene");
    expect(dynamic.textContent).toBe('"Try again" yeteneği silinsin mi?');
    expect(dynamic.title).toBe("Tekrar dene");
    expect(trusted.textContent).toBe("Tekrar dene");
    expect(document.querySelector("[data-locale-ignore] span")?.textContent).toBe("Try again");
    expect(document.querySelector("#content")?.textContent).toBe("Try again");
    const added = document.createElement("button");
    added.dataset.i18n = "try.again";
    document.body.append(added);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(added.textContent).toBe("Tekrar dene");
    applyExtensionLocale("en")();
    expect(document.querySelector("input")?.value).toBe("Try again");
    expect(document.querySelector("option")?.getAttribute("label")).toBe("Try again");
    expect(dynamic.textContent).toBe('Delete skill "Try again"?');
    expect(dynamic.title).toBe("Try again");
    expect(trusted.textContent).toBe("Try again");
    setText(dynamic, "Try again");
    applyExtensionLocale("tr")();
    expect(dynamic.textContent).toBe("Try again");
  });
});
