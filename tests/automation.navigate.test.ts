import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { executeNavigateTool } from "../apps/chrome-extension/src/automation/navigate";
import { listSkills } from "../apps/chrome-extension/src/automation/skills-store";

vi.mock("../apps/chrome-extension/src/automation/skills-store", () => ({ listSkills: vi.fn() }));

const originalTab = { id: 12, windowId: 3, url: "https://example.com/old", title: "Old" };
const finalTab = { ...originalTab, url: "https://example.com/final", title: "Final" };
const tabs = {
  create: vi.fn(),
  query: vi.fn(),
  update: vi.fn(),
  get: vi.fn(),
  onUpdated: { addListener: vi.fn(), removeListener: vi.fn() },
};
const windows = { update: vi.fn() };

beforeEach(() => {
  vi.useFakeTimers();
  vi.resetAllMocks();
  vi.stubGlobal("chrome", { tabs, windows });
  tabs.create.mockResolvedValue(originalTab);
  tabs.query.mockResolvedValue([originalTab]);
  tabs.get.mockResolvedValue(finalTab);
  vi.mocked(listSkills).mockResolvedValue([
    {
      name: "Example",
      shortDescription: "Example actions",
      description: "Full instructions",
      domainPatterns: ["example.com"],
      createdAt: "",
      lastUpdated: "",
      examples: "",
      library: "",
    },
  ]);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("automation navigation", () => {
  it.each([false, true])("returns completed-tab metadata (newTab=%s)", async (newTab) => {
    const result = executeNavigateTool({ url: " https://example.com/start ", newTab });
    await vi.advanceTimersByTimeAsync(0);
    const listener = tabs.onUpdated.addListener.mock.calls[0][0];
    listener(99, { status: "complete" });
    listener(12, { status: "loading" });
    expect(tabs.get).not.toHaveBeenCalled();
    listener(12, { status: "complete" });

    await expect(result).resolves.toEqual({
      finalUrl: finalTab.url,
      title: finalTab.title,
      tabId: 12,
      skills: [{ name: "Example", shortDescription: "Example actions" }],
    });
    expect(listSkills).toHaveBeenCalledWith(finalTab.url);
    expect(tabs.onUpdated.removeListener).toHaveBeenCalledWith(listener);
    expect(vi.getTimerCount()).toBe(0);
    if (newTab) {
      expect(tabs.create).toHaveBeenCalledWith({ url: "https://example.com/start" });
      expect(tabs.update).not.toHaveBeenCalled();
    } else {
      expect(tabs.query).toHaveBeenCalledWith({ active: true, currentWindow: true });
      expect(tabs.update).toHaveBeenCalledWith(12, { url: "https://example.com/start" });
      expect(tabs.create).not.toHaveBeenCalled();
    }
    expect(windows.update).not.toHaveBeenCalled();
  });

  it.each([originalTab.url, undefined])(
    "preserves timeout fallback for tab URL %s",
    async (url) => {
      tabs.create.mockResolvedValue({ id: 12, windowId: 3, url });
      const result = executeNavigateTool({ url: "https://example.com/start", newTab: true });
      await vi.advanceTimersByTimeAsync(15_000);

      await expect(result).resolves.toMatchObject({
        finalUrl: url ?? "https://example.com/start",
        title: null,
        tabId: 12,
      });
      expect(vi.mocked(listSkills).mock.calls).toEqual(url ? [[url]] : []);
      expect(tabs.onUpdated.removeListener).toHaveBeenCalledOnce();
    },
  );

  it("switches and focuses the requested tab before describing it", async () => {
    await expect(executeNavigateTool({ switchToTab: 12 })).resolves.toMatchObject({
      switchedToTab: 12,
      tabId: 12,
      finalUrl: finalTab.url,
    });
    expect(tabs.update).toHaveBeenCalledWith(12, { active: true });
    expect(windows.update).toHaveBeenCalledWith(3, { focused: true });
    expect(tabs.update.mock.invocationCallOrder[0]).toBeLessThan(
      windows.update.mock.invocationCallOrder[0],
    );
    expect(windows.update.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(listSkills).mock.invocationCallOrder[0],
    );
  });

  it.each([
    [false, "No active tab"],
    [true, "Failed to open new tab"],
  ] as const)("keeps missing-tab errors specific (newTab=%s)", async (newTab, message) => {
    tabs.create.mockResolvedValue({});
    tabs.query.mockResolvedValue([]);
    await expect(executeNavigateTool({ url: "https://example.com", newTab })).rejects.toThrow(
      message,
    );
    expect(tabs.onUpdated.addListener).not.toHaveBeenCalled();
  });
});
