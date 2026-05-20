import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

function installLocalStorage() {
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: vi.fn((key: string) => values.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => {
      values.set(key, value);
    }),
    removeItem: vi.fn((key: string) => {
      values.delete(key);
    }),
    clear: vi.fn(() => {
      values.clear();
    }),
  });
}

describe("chrome storage fallback", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubGlobal("chrome", {});
    installLocalStorage();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("loads and saves settings without chrome.storage.local", async () => {
    const { loadSettings, saveSettings } =
      await import("../apps/chrome-extension/src/lib/settings.js");

    const initial = await loadSettings();
    expect(initial.model).toBe("auto");

    await saveSettings({ ...initial, model: "openai/gpt-5.5", autoSummarize: false });
    const saved = await loadSettings();
    expect(saved.model).toBe("openai/gpt-5.5");
    expect(saved.autoSummarize).toBe(false);
  });

  it("seeds automation skills without chrome.storage.local", async () => {
    const { listSkills } = await import("../apps/chrome-extension/src/automation/skills-store.js");

    const skills = await listSkills();
    expect(skills.length).toBeGreaterThan(0);
  });
});
