import { describe, expect, it, vi } from "vitest";
import { createOptionsSaveRuntime } from "../apps/chrome-extension/src/entrypoints/options/persistence.js";
import { message } from "../apps/chrome-extension/src/lib/i18n";

describe("options persistence", () => {
  it("debounces autosave and flushes one queued rerun", async () => {
    vi.useFakeTimers();
    const persist = vi.fn(async () => {});
    const setStatus = vi.fn();
    const flashStatus = vi.fn();

    const runtime = createOptionsSaveRuntime({
      isInitializing: () => false,
      setStatus,
      flashStatus,
      persist,
    });

    runtime.scheduleAutoSave(200);
    runtime.scheduleAutoSave(200);
    await vi.advanceTimersByTimeAsync(199);
    expect(persist).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(persist).toHaveBeenCalledTimes(1);

    const blockedPersist = vi.fn(() => new Promise<void>((resolve) => setTimeout(resolve, 10)));
    const queuedRuntime = createOptionsSaveRuntime({
      isInitializing: () => false,
      setStatus,
      flashStatus,
      persist: blockedPersist,
    });

    const first = queuedRuntime.saveNow();
    const second = queuedRuntime.saveNow();
    await vi.advanceTimersByTimeAsync(20);
    await Promise.all([first, second]);

    expect(blockedPersist).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it("surfaces direct save failures instead of leaving Saving visible", async () => {
    const persist = vi.fn(async () => {
      throw new Error("storage unavailable");
    });
    const setStatus = vi.fn();
    const flashStatus = vi.fn();

    const runtime = createOptionsSaveRuntime({
      isInitializing: () => false,
      setStatus,
      flashStatus,
      persist,
    });

    await expect(runtime.saveNow()).resolves.toBeUndefined();

    expect(setStatus).toHaveBeenLastCalledWith(
      message("settings.saveFailed", { error: "storage unavailable", hasError: true }),
    );
    expect(flashStatus).not.toHaveBeenCalledWith(message("saved"));
  });

  it("handles autosave failures without an unhandled rejection", async () => {
    vi.useFakeTimers();
    const persist = vi.fn(async () => {
      throw new Error("quota exceeded");
    });
    const setStatus = vi.fn();
    const flashStatus = vi.fn();

    const runtime = createOptionsSaveRuntime({
      isInitializing: () => false,
      setStatus,
      flashStatus,
      persist,
    });

    runtime.scheduleAutoSave(10);
    await vi.advanceTimersByTimeAsync(10);

    expect(setStatus).toHaveBeenLastCalledWith(
      message("settings.saveFailed", { error: "quota exceeded", hasError: true }),
    );
    expect(flashStatus).not.toHaveBeenCalledWith(message("saved"));
    vi.useRealTimers();
  });
});
