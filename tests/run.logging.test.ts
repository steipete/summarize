import { describe, expect, it, vi } from "vitest";
import { createRetryLogger, writeVerbose } from "../src/run/logging.js";

describe("run/logging", () => {
  it("preserves raw diagnostic data in Turkish mode", () => {
    const write = vi.fn();
    writeVerbose(
      { write } as unknown as NodeJS.WritableStream,
      true,
      "Copy failed: /Projects (old)/cache.json",
      false,
      { SUMMARIZE_LOCALE: "tr" },
    );
    expect(write).toHaveBeenCalledWith(
      expect.stringContaining("Copy failed: /Projects (old)/cache.json"),
    );
  });

  it("formats retry reasons", () => {
    const stderr = { write: vi.fn() } as unknown as NodeJS.WritableStream;

    const log = createRetryLogger({
      stderr,
      verbose: true,
      color: false,
      modelId: "openai/gpt-test",
    });

    log({ attempt: 1, maxRetries: 2, delayMs: 10, error: "Empty summary" });
    expect((stderr.write as unknown as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]).toContain(
      "LLM empty output",
    );

    log({ attempt: 2, maxRetries: 2, delayMs: 10, error: new Error("timed out") });
    expect((stderr.write as unknown as ReturnType<typeof vi.fn>).mock.calls[1]?.[0]).toContain(
      "LLM timeout",
    );

    log({ attempt: 3, maxRetries: 4, delayMs: 10, error: { message: "something else" } });
    expect((stderr.write as unknown as ReturnType<typeof vi.fn>).mock.calls[2]?.[0]).toContain(
      "LLM error",
    );
  });
});
