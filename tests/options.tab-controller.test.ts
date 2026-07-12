// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createOptionsTabs } from "../apps/chrome-extension/src/entrypoints/options/tab-controller.js";

const storageKey = "summarize:options-tab";

function createStorage() {
  const values = new Map<string, string>();
  return {
    clear: () => values.clear(),
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  };
}

function createHarness() {
  document.body.innerHTML = `
    <div id="tabs">
      <button data-tab="general" aria-selected="true"></button>
      <button data-tab="runtime" aria-selected="false"></button>
      <button data-tab="logs" aria-selected="false"></button>
    </div>
    <section data-tab-panel="general"></section>
    <section data-tab-panel="runtime" hidden></section>
    <section data-tab-panel="logs" hidden></section>
  `;
  const root = document.querySelector<HTMLDivElement>("#tabs");
  if (!root) throw new Error("missing tabs");
  return {
    root,
    buttons: Array.from(root.querySelectorAll<HTMLButtonElement>("[data-tab]")),
    panels: Array.from(document.querySelectorAll<HTMLElement>("[data-tab-panel]")),
    onLogsActiveChange: vi.fn(),
    onProcessesActiveChange: vi.fn(),
  };
}

describe("options tab controller", () => {
  let storage: ReturnType<typeof createStorage>;

  beforeEach(() => {
    storage = createStorage();
    vi.stubGlobal("localStorage", storage);
    window.history.replaceState(null, "", "/options.html");
  });

  it("uses a requested tab before the stored tab", () => {
    storage.setItem(storageKey, "logs");
    window.history.replaceState(null, "", "/options.html?tab=runtime");
    const harness = createHarness();

    const tabs = createOptionsTabs({
      ...harness,
      storageKey,
    });

    expect(tabs.resolveActiveTab()).toBe("runtime");
    expect(storage.getItem(storageKey)).toBe("runtime");
    expect(document.querySelector<HTMLElement>('[data-tab-panel="runtime"]')?.hidden).toBe(false);
  });

  it("clears the requested tab after the user picks a different tab", () => {
    storage.setItem(storageKey, "general");
    window.history.replaceState(null, "", "/options.html?tab=runtime");
    const harness = createHarness();

    const tabs = createOptionsTabs({
      ...harness,
      storageKey,
    });

    expect(tabs.resolveActiveTab()).toBe("runtime");

    harness.buttons.find((button) => button.dataset.tab === "logs")?.click();

    expect(tabs.resolveActiveTab()).toBe("logs");
    expect(storage.getItem(storageKey)).toBe("logs");
    expect(window.location.search).toBe("");

    const reloaded = createHarness();
    const reloadedTabs = createOptionsTabs({
      ...reloaded,
      storageKey,
    });

    expect(reloadedTabs.resolveActiveTab()).toBe("logs");
    expect(reloaded.onLogsActiveChange).toHaveBeenCalledWith(true);
  });

  it("falls back to the stored tab when the requested tab is invalid", () => {
    storage.setItem(storageKey, "logs");
    window.history.replaceState(null, "", "/options.html?tab=missing");
    const harness = createHarness();

    const tabs = createOptionsTabs({
      ...harness,
      storageKey,
    });

    expect(tabs.resolveActiveTab()).toBe("logs");
    expect(harness.onLogsActiveChange).toHaveBeenCalledWith(true);
  });
});
