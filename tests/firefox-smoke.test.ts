import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ spawn: vi.fn(), spawnSync: vi.fn(), rmSync: vi.fn() }));
vi.mock("node:child_process", () => mocks);
vi.mock("node:fs", () => ({
  default: {
    existsSync: () => true,
    mkdtempSync: () => "/synthetic/firefox-profile",
    rmSync: mocks.rmSync,
  },
}));

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.resetModules();
  mocks.spawn.mockReset();
});

describe("Firefox smoke lifecycle", () => {
  it("owns the browser runner directly and waits for extension installation", async () => {
    vi.useFakeTimers();
    vi.stubEnv("FIREFOX_BINARY", "/synthetic/firefox");
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      killed: false,
      kill: vi.fn((signal: string) => {
        child.killed = true;
        child.emit("exit", 0, signal);
        child.emit("close", 0, signal);
        return true;
      }),
    });
    mocks.spawn.mockReturnValue(child);
    const running = import("../apps/chrome-extension/scripts/firefox-smoke.mjs");
    await vi.waitFor(() => expect(mocks.spawn).toHaveBeenCalledOnce());
    try {
      expect(mocks.spawn.mock.calls[0][0]).toBe(process.execPath);
      expect(mocks.spawn.mock.calls[0][1][0]).toMatch(/web-ext[/\\]bin[/\\]web-ext\.js$/);
      child.stdout.write("Running web extension\n");
      await vi.advanceTimersByTimeAsync(3_100);
      expect(child.kill).not.toHaveBeenCalled();
      child.stdout.write("Installed fixture as a temporary add-on\n");
      await vi.advanceTimersByTimeAsync(3_100);
      expect(child.kill).toHaveBeenCalledExactlyOnceWith("SIGINT");
      expect(mocks.rmSync).toHaveBeenCalledWith(
        "/synthetic/firefox-profile",
        expect.objectContaining({ recursive: true, force: true }),
      );
      await running;
    } finally {
      child.stdout.write("Installed fixture as a temporary add-on\n");
      await vi.advanceTimersByTimeAsync(3_100);
      await running;
      child.stdout.destroy();
      child.stderr.destroy();
    }
  });
});
