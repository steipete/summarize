import { beforeEach, describe, expect, it } from "vitest";
import {
  defaultSettings,
  loadSettings,
  patchSettings,
  saveSettings,
} from "../apps/chrome-extension/src/lib/settings.js";
import { installChromeStorage } from "./helpers/chrome-storage.js";

describe("chrome/settings", () => {
  let storage: Record<string, unknown>;

  beforeEach(() => {
    storage = {};
    installChromeStorage(storage, "local");
  });

  it("loads defaults when storage is empty", async () => {
    const s = await loadSettings();
    expect(s).toEqual({
      ...defaultSettings,
      daemonAllowed: true,
      daemonManaged: false,
    });
    expect(s.length).toBe("long");
  });

  it("normalizes model/length/language on save", async () => {
    await saveSettings({
      ...defaultSettings,
      token: "t",
      model: "Auto",
      length: "S",
      language: " German ",
    });

    const raw = storage.settings as Record<string, unknown>;
    expect(raw.model).toBe("auto");
    expect(raw.length).toBe("short");
    expect(raw.language).toBe("German");

    const loaded = await loadSettings();
    expect(loaded.model).toBe("auto");
    expect(loaded.length).toBe("short");
    expect(loaded.language).toBe("German");
  });

  it("patches settings and persists them", async () => {
    await patchSettings({ token: "x", length: "20k", language: "en" });
    const loaded = await loadSettings();
    expect(loaded.token).toBe("x");
    expect(loaded.length).toBe("20k");
    expect(loaded.language).toBe("en");
  });

  it("persists slide OCR preference", async () => {
    await patchSettings({ slidesOcrEnabled: true });
    const loaded = await loadSettings();
    expect(loaded.slidesOcrEnabled).toBe(true);
  });

  it("persists daemon hint dismissal", async () => {
    await patchSettings({ daemonHintDismissed: true });
    expect((await loadSettings()).daemonHintDismissed).toBe(true);

    storage.settings = { daemonHintDismissed: "yes" };
    expect((await loadSettings()).daemonHintDismissed).toBe(false);
  });

  it("normalizes slide runtime preferences", async () => {
    await patchSettings({ slideRuntime: "daemon" });
    expect((await loadSettings()).slideRuntime).toBe("daemon");

    storage.settings = { slideRuntime: "browser" };
    expect((await loadSettings()).slideRuntime).toBe("browser");

    storage.settings = { slideRuntime: "native" };
    expect((await loadSettings()).slideRuntime).toBe(defaultSettings.slideRuntime);
  });

  it("migrates the legacy daemonless slide preference", async () => {
    storage.settings = { daemonlessSlides: false };
    expect((await loadSettings()).slideRuntime).toBe("daemon");

    storage.settings = { daemonlessSlides: true };
    expect((await loadSettings()).slideRuntime).toBe("browser");
  });

  it("migrates the old browser AI runtime to Direct with Gemini Nano selected", async () => {
    storage.settings = { summaryRuntime: "browser", model: "auto" };

    const loaded = await loadSettings();
    expect(loaded.summaryRuntime).toBe("direct");
    expect(loaded.model).toBe("browser/gemini-nano");
  });

  it("normalizes advanced overrides on save", async () => {
    await saveSettings({
      ...defaultSettings,
      requestMode: "URL",
      firecrawlMode: "Always",
      markdownMode: "LLM",
      preprocessMode: "AUTO",
      youtubeMode: "No-Auto",
      timeout: " 90s ",
      retries: 3.9,
      maxOutputTokens: " 2k ",
    });

    const raw = storage.settings as Record<string, unknown>;
    expect(raw.requestMode).toBe("url");
    expect(raw.firecrawlMode).toBe("always");
    expect(raw.markdownMode).toBe("llm");
    expect(raw.preprocessMode).toBe("auto");
    expect(raw.youtubeMode).toBe("no-auto");
    expect(raw.timeout).toBe("90s");
    expect(raw.retries).toBe(3);
    expect(raw.maxOutputTokens).toBe("2k");

    const loaded = await loadSettings();
    expect(loaded.requestMode).toBe("url");
    expect(loaded.firecrawlMode).toBe("always");
    expect(loaded.markdownMode).toBe("llm");
    expect(loaded.preprocessMode).toBe("auto");
    expect(loaded.youtubeMode).toBe("no-auto");
    expect(loaded.timeout).toBe("90s");
    expect(loaded.retries).toBe(3);
    expect(loaded.maxOutputTokens).toBe("2k");
  });

  it("drops invalid advanced numeric settings", async () => {
    await saveSettings({
      ...defaultSettings,
      maxChars: Number.NaN,
      timeout: "soon",
      maxOutputTokens: "8",
      fontSize: 99,
    });

    const raw = storage.settings as Record<string, unknown>;
    expect(raw.maxChars).toBe(defaultSettings.maxChars);
    expect(raw.timeout).toBe(defaultSettings.timeout);
    expect(raw.maxOutputTokens).toBe(defaultSettings.maxOutputTokens);
    expect(raw.fontSize).toBe(defaultSettings.fontSize);
  });

  it("normalizes numeric settings loaded from storage", async () => {
    storage.settings = {
      maxChars: "40000",
      timeout: "1.5m",
      maxOutputTokens: "1.5k",
      fontSize: "15.4",
    };

    const loaded = await loadSettings();
    expect(loaded.maxChars).toBe(40_000);
    expect(loaded.timeout).toBe("1.5m");
    expect(loaded.maxOutputTokens).toBe("1.5k");
    expect(loaded.fontSize).toBe(15);
  });

  it("normalizes auto CLI fallback settings", async () => {
    await saveSettings({
      ...defaultSettings,
      autoCliFallback: false,
      autoCliOrder: " GeMiNi,openclaw,opencode,copilot,agy,pi,unknown,CLAUDE,gemini,COPILOT ",
    });

    const raw = storage.settings as Record<string, unknown>;
    expect(raw.autoCliFallback).toBe(false);
    expect(raw.autoCliOrder).toBe("gemini,openclaw,opencode,copilot,agy,pi,claude");

    const loaded = await loadSettings();
    expect(loaded.autoCliFallback).toBe(false);
    expect(loaded.autoCliOrder).toBe("gemini,openclaw,opencode,copilot,agy,pi,claude");
  });
});
