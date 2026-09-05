// @vitest-environment happy-dom

import { describe, expect, it } from "vitest";
import {
  applyExtensionLocale,
  extensionTranslationKeys,
  getActiveExtensionLocale,
  resolveExtensionLocale,
  translateExtensionText,
} from "../apps/chrome-extension/src/lib/i18n.js";
import {
  cliTranslationKeys,
  hasTurkishTranslation,
  resolveCliLocale,
  resolveCliLocaleFromArgs,
  resolveCliLocaleFromEnv,
  translateCliText,
} from "../src/locale.js";

describe("locale selection and fallback", () => {
  it("selects Turkish from aliases and falls back to English", () => {
    expect(resolveCliLocale("tr-TR")).toBe("tr");
    expect(resolveCliLocale("turkish")).toBe("tr");
    expect(resolveCliLocale("fr")).toBe("en");
    expect(resolveCliLocaleFromEnv({ SUMMARIZE_LOCALE: "tr_TR.UTF-8" })).toBe("tr");
    expect(resolveCliLocaleFromEnv({ LANG: "tr_TR.UTF-8" })).toBe("en");
    expect(resolveCliLocaleFromArgs(["--locale", "tr"], {})).toBe("tr");
    expect(resolveCliLocaleFromArgs(["--locale=tr"], {})).toBe("tr");
    expect(resolveCliLocaleFromArgs(["--", "--locale=tr"], {})).toBe("en");
    expect(resolveCliLocaleFromArgs(["--locale", "tr", "--", "--locale=en"], {})).toBe("tr");
  });

  it("translates representative CLI text without touching technical identifiers", () => {
    const help = translateCliText(
      "Usage: summarize <input> [flags]\n  --language, --lang <language>\n  --model openai/gpt-5-mini",
      "tr",
    );
    expect(help).toContain("Kullanım: summarize <input> [flags]");
    expect(help).toContain("--language, --lang <language>");
    expect(help).toContain("openai/gpt-5-mini");
    const technical = translateCliText(
      "OpenAI service tier: default, fast, priority, flex. https://example.com/default --model openai/gpt-5 service_tier=priority",
      "tr",
    );
    expect(technical).toContain("default, fast, priority, flex");
    expect(technical).toContain("https://example.com/default");
    expect(technical).toContain("--model openai/gpt-5");
    expect(technical).toContain("service_tier=priority");
    expect(translateCliText("Fetching website", "tr")).toBe("Web sitesi alınıyor");
    expect(translateCliText("Fetching website", "en")).toBe("Fetching website");
  });

  it("keeps translation keys explicit for coverage checks", () => {
    expect(cliTranslationKeys.length).toBeGreaterThan(30);
    expect(extensionTranslationKeys.length).toBeGreaterThan(80);
    expect(hasTurkishTranslation("Try again")).toBe(true);
    expect(hasTurkishTranslation("provider/model")).toBe(false);
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
  ])("preserves technical paths before multiword replacements: %s", (value) => {
    const translated = translateCliText(`Copy failed: (${value})`, "tr", [value]);
    expect(translated).toBe(`Kopyalama başarısız: (${value})`);
    expect(translateCliText(`Wrote ${value}`, "tr", [value])).toContain(value);
  });

  it("still translates fixed help descriptions containing a literal configuration path", () => {
    const help =
      "Output language: auto (match source), en, de, english, german, ... (default: auto; configurable in ~/.summarize/config.json via output.language)";
    expect(translateCliText(help, "tr")).toContain("Çıktı dili:");
    expect(translateCliText(help, "tr")).toContain("~/.summarize/config.json");
    expect(translateCliText('Copy failed: "Copy failed"', "tr", ['"Copy failed"'])).toBe(
      'Kopyalama başarısız: "Copy failed"',
    );
    expect(translateCliText("Wrote old/0.json", "tr", ["old/0.json", "0", ""])).toContain(
      "old/0.json",
    );
  });
});

describe("extension locale", () => {
  it("uses explicit locale before browser detection and detects Turkish", () => {
    expect(resolveExtensionLocale("tr", "en-US")).toBe("tr");
    expect(resolveExtensionLocale("en", "tr-TR")).toBe("en");
    expect(resolveExtensionLocale("auto", "tr-TR")).toBe("tr");
    expect(resolveExtensionLocale("auto", "fr-FR")).toBe("en");
  });

  it("translates extension labels and preserves dynamic values", () => {
    expect(translateExtensionText("Try again", "tr")).toBe("Tekrar dene");
    expect(translateExtensionText("Page · 123 words", "tr")).toBe("Sayfa · 123 kelime");
    expect(translateExtensionText("custom model id", "tr")).toBe("özel model kimliği");
    expect(translateExtensionText("--model openai/gpt-5", "tr")).toBe("--model openai/gpt-5");
    expect(translateExtensionText("Slide 3", "tr")).toBe("Slayt 3");
    expect(translateExtensionText("123 words", "tr")).toBe("123 kelime");
    expect(translateExtensionText("Context 50% · 2 msgs · 1,024 chars", "tr")).toBe(
      "Bağlam 50% · 2 mesaj · 1,024 karakter",
    );
    expect(translateExtensionText("Queue full (3). Remove one to add more.", "tr")).toBe(
      "Kuyruk dolu (3). Daha fazla eklemek için birini kaldırın.",
    );
  });

  it("translates existing and later UI nodes without touching ignored content", async () => {
    document.body.innerHTML = `
      <main data-locale-ui>
        <button id="retry" title="Try again">Try again</button>
        <div id="dynamic"></div>
        <div data-locale-ignore="true"><span>Try again</span></div>
      </main>
      <div id="content">Try again</div>
    `;
    const stop = applyExtensionLocale("tr");
    expect(getActiveExtensionLocale()).toBe("tr");
    expect(document.querySelector("#retry")?.textContent).toBe("Tekrar dene");
    expect(document.querySelector("#retry")?.getAttribute("title")).toBe("Tekrar dene");
    expect(document.querySelector("[data-locale-ignore]")?.textContent?.trim()).toBe("Try again");
    expect(document.querySelector("#content")?.textContent).toBe("Try again");

    const dynamic = document.querySelector<HTMLElement>("#dynamic");
    if (!dynamic) throw new Error("dynamic test node missing");
    dynamic.textContent = "Loading logs…";
    const content = document.querySelector<HTMLElement>("#content");
    if (!content) throw new Error("content test node missing");
    content.textContent = "Loading logs…";
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(dynamic.textContent).toBe("Günlükler yükleniyor…");
    expect(content.textContent).toBe("Loading logs…");

    stop();
    applyExtensionLocale("en")();
    expect(getActiveExtensionLocale()).toBe("en");
    expect(document.querySelector("#retry")?.textContent).toBe("Try again");
  });
});
