import { beforeEach, describe, expect, it, vi } from "vitest";
import { discardStream as noopStream } from "./helpers/streams.js";

const mocks = vi.hoisted(() => ({
  close: vi.fn(),
  execute: vi.fn(),
}));

vi.mock("../src/run/cache-state.js", () => ({
  createCacheStateFromConfig: vi.fn(async () => ({
    mode: "default",
    store: {
      getText: vi.fn(() => null),
      getJson: vi.fn(() => null),
      setText: vi.fn(),
      setJson: vi.fn(),
      clear: vi.fn(),
      close: mocks.close,
      transcriptCache: {
        get: vi.fn(async () => null),
        set: vi.fn(async () => {}),
      },
    },
    ttlMs: 0,
    maxBytes: 0,
    path: "/tmp/summarize-command-cache.sqlite",
  })),
}));

vi.mock("../src/run/cli-summarize-execution.js", () => ({
  createCliSummarizeExecutor: vi.fn(() => mocks.execute),
}));

import { runCli } from "../src/run.js";

describe("CLI summarize command lifecycle", () => {
  beforeEach(() => {
    mocks.close.mockClear();
    mocks.execute.mockReset();
  });

  it("closes the cache when post-cache validation fails", async () => {
    await expect(
      runCli(["--markdown-mode", "auto", "https://example.com"], {
        env: {},
        fetch: vi.fn() as unknown as typeof fetch,
        stdout: noopStream(),
        stderr: noopStream(),
      }),
    ).rejects.toThrow("--markdown-mode is only supported with --format md");

    expect(mocks.execute).not.toHaveBeenCalled();
    expect(mocks.close).toHaveBeenCalledOnce();
  });

  it("closes the cache when summarize execution fails", async () => {
    mocks.execute.mockRejectedValueOnce(new Error("execution failed"));

    await expect(
      runCli(["--extract", "https://example.com"], {
        env: {},
        fetch: vi.fn() as unknown as typeof fetch,
        stdout: noopStream(),
        stderr: noopStream(),
      }),
    ).rejects.toThrow("execution failed");

    expect(mocks.execute).toHaveBeenCalledOnce();
    expect(mocks.close).toHaveBeenCalledOnce();
  });
});
