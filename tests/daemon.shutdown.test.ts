import { describe, expect, it, vi } from "vitest";
import { closeAfterActiveTasks } from "../src/daemon/server.js";

describe("daemon shutdown", () => {
  it("defers resource close until active tasks and their descendants settle", async () => {
    vi.useFakeTimers();
    try {
      let resolveParent: (() => void) | null = null;
      let resolveChild: (() => void) | null = null;
      const parent = new Promise<void>((resolve) => {
        resolveParent = resolve;
      });
      const child = new Promise<void>((resolve) => {
        resolveChild = resolve;
      });
      const activeTasks = new Set<Promise<void>>([parent]);
      let resolveClosed: (() => void) | null = null;
      const closed = new Promise<void>((resolve) => {
        resolveClosed = resolve;
      });
      const close = vi.fn(() => resolveClosed?.());

      const shutdown = closeAfterActiveTasks({ activeTasks, timeoutMs: 100, close });
      await vi.advanceTimersByTimeAsync(100);
      await expect(shutdown).resolves.toBe(false);
      expect(close).not.toHaveBeenCalled();

      activeTasks.add(child);
      resolveParent?.();
      await vi.runAllTicks();
      expect(close).not.toHaveBeenCalled();

      resolveChild?.();
      await closed;
      expect(close).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });
});
