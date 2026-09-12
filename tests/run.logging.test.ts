import { describe, expect, it, vi } from "vitest";
import { formatLlmRetryNotice } from "../src/llm/generate-text-shared.js";
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

  it.each([
    ["Empty summary", "empty output"],
    [new Error("timed out"), "timeout"],
    [{ message: "something else" }, "error"],
    [{ errorMessage: "timed out" }, "error"],
    [undefined, "error"],
  ])("formats retry reason for %j", (error, reason) => {
    const stderr = { write: vi.fn() } as unknown as NodeJS.WritableStream;

    const log = createRetryLogger({
      stderr,
      verbose: true,
      color: false,
      modelId: "openai/gpt-test",
    });

    const notice = { attempt: 1, maxRetries: 2, delayMs: 10, error };
    const expected = `LLM ${reason} for openai/gpt-test; retry 1/2 in 10ms.`;
    expect(formatLlmRetryNotice("openai/gpt-test", notice)).toBe(expected);
    log(notice);
    expect(stderr.write).toHaveBeenCalledExactlyOnceWith(expect.stringContaining(expected));
  });
});
