import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  extractFromTab,
  prepareCurrentSlideFrameInTab,
  prepareSlideFrameInTab,
  seekInTab,
} from "../apps/chrome-extension/src/entrypoints/background/content-script-bridge.js";

const sendMessage = vi.fn();
const executeScript = vi.fn();
const success = { ok: true, url: "https://example.com", text: "page" };
const methods = [
  {
    name: "extract",
    run: () => extractFromTab(7, 1000, { timeoutMs: 10 }),
    request: { type: "extract", maxChars: 1000, inputMode: undefined },
    result: { ok: true, data: success },
  },
  {
    name: "seek",
    run: () => seekInTab(7, 12),
    request: { type: "seek", seconds: 12 },
    result: { ok: true },
  },
  {
    name: "frame",
    run: () => prepareSlideFrameInTab(7, 12),
    request: { type: "prepare-slide-frame", seconds: 12 },
    result: { ok: true, data: success },
  },
  {
    name: "current frame",
    run: () => prepareCurrentSlideFrameInTab(7),
    request: { type: "prepare-current-slide-frame" },
    result: { ok: true, data: success },
  },
];

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  sendMessage.mockReset().mockResolvedValue(success);
  executeScript.mockReset().mockResolvedValue([]);
  vi.stubGlobal("chrome", { tabs: { sendMessage }, scripting: { executeScript } });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function settle<Result>(pending: Promise<Result>): Promise<Result> {
  await vi.runAllTimersAsync();
  return pending;
}

describe.each(methods)("content bridge: $name", ({ run, request, result }) => {
  it("keeps request and success envelopes unchanged", async () => {
    expect(await settle(run())).toEqual(result);
    expect(sendMessage).toHaveBeenCalledExactlyOnceWith(7, request);
    expect(executeScript).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("returns application errors without retrying", async () => {
    sendMessage.mockResolvedValue({ ok: false, error: "content error", ignored: true });
    expect(await settle(run())).toEqual({ ok: false, error: "content error" });
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(executeScript).not.toHaveBeenCalled();
  });

  it.each(["Receiving end does not exist", "Could not establish connection"])(
    "reinjects after %s",
    async (message) => {
      sendMessage.mockRejectedValueOnce(new Error(message));
      expect(await settle(run())).toEqual(result);
      expect(executeScript).toHaveBeenCalledExactlyOnceWith({
        target: { tabId: 7 },
        files: ["content-scripts/extract.js"],
      });
      expect(sendMessage).toHaveBeenCalledTimes(2);
      expect(Date.now()).toBe(120);
    },
  );

  it("keeps the third missing-receiver injection and delay", async () => {
    sendMessage.mockRejectedValue(new Error("Receiving end does not exist"));
    expect(await settle(run())).toEqual({ ok: false, error: "Content script not ready" });
    expect(sendMessage).toHaveBeenCalledTimes(3);
    expect(executeScript).toHaveBeenCalledTimes(3);
    expect(Date.now()).toBe(360);
  });

  it("uses the generic backoff without injecting on unrelated errors", async () => {
    sendMessage.mockRejectedValue(new Error("port closed"));
    expect(await settle(run())).toEqual({ ok: false, error: "port closed" });
    expect(sendMessage).toHaveBeenCalledTimes(3);
    expect(executeScript).not.toHaveBeenCalled();
    expect(Date.now()).toBe(700);
  });

  it("stops immediately when injection is blocked", async () => {
    sendMessage.mockRejectedValue(new Error("Receiving end does not exist"));
    executeScript.mockRejectedValue(new Error("Cannot access this page"));
    expect(await settle(run())).toEqual({
      ok: false,
      error: expect.stringContaining("Chrome blocked content access"),
    });
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(Date.now()).toBe(0);
  });
});

it("keeps extraction deadlines, terminal guidance, and attempt logs", async () => {
  sendMessage.mockImplementation(() => new Promise(() => {}));
  const log = vi.fn();
  const result = await settle(extractFromTab(7, 1000, { timeoutMs: 10, log }));
  expect(result).toEqual({
    ok: false,
    error: "Page extraction timed out. Reload the tab (or “Summarize → Refresh”), then retry.",
  });
  expect(log).toHaveBeenCalledWith("extract:attempt", { attempt: 3, timeoutMs: 10 });
  expect(executeScript).toHaveBeenCalledTimes(3);
  expect(Date.now()).toBe(270);
  expect(vi.getTimerCount()).toBe(0);
});

it("does not apply extraction timeout policy to a seek error", async () => {
  sendMessage.mockRejectedValue(new Error("extract timed out"));
  expect(await settle(seekInTab(7, 12))).toEqual({ ok: false, error: "extract timed out" });
  expect(executeScript).not.toHaveBeenCalled();
  expect(Date.now()).toBe(700);
});
