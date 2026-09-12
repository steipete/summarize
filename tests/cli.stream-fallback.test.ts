import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { runCli } from "../src/run.js";
import { captureStream as collectStream } from "./helpers/streams.js";

const mocks = vi.hoisted(() => ({
  generateTextWithModelId: vi.fn(async () => ({
    text: "fallback summary",
    canonicalModelId: "openai/gpt-5.2",
    provider: "openai",
    usage: { promptTokens: 1, completionTokens: 2, totalTokens: 3 },
  })),
  streamTextWithModelId: vi.fn(async () => ({
    textStream: {
      async *[Symbol.asyncIterator]() {
        throw new Error("LLM request timed out");
      },
    },
    canonicalModelId: "openai/gpt-5.2",
    provider: "openai",
    usage: Promise.resolve({ promptTokens: 1, completionTokens: 0, totalTokens: 1 }),
    lastError: (): unknown => null,
  })),
}));

vi.mock("../src/llm/generate-text.js", () => mocks);

beforeEach(() => {
  mocks.generateTextWithModelId.mockClear();
  mocks.streamTextWithModelId.mockClear();
});

describe("cli stream fallback", () => {
  it("falls back when the stream iterator times out before yielding text", async () => {
    const root = mkdtempSync(join(tmpdir(), "summarize-stream-fallback-"));
    const filePath = join(root, "input.txt");
    writeFileSync(filePath, "hello world", "utf8");
    const stdout = collectStream();
    const stderr = collectStream();

    await runCli(["--model", "openai/gpt-5.2", "--stream", "on", "--plain", filePath], {
      env: { HOME: root, OPENAI_API_KEY: "test" },
      fetch: async () => {
        throw new Error("unexpected fetch");
      },
      stdout: stdout.stream,
      stderr: stderr.stream,
    });

    expect(stdout.getText()).toContain("fallback summary");
    expect(mocks.streamTextWithModelId).toHaveBeenCalledTimes(1);
    expect(mocks.generateTextWithModelId).toHaveBeenCalledTimes(1);
    expect(mocks.generateTextWithModelId).toHaveBeenCalledWith(
      expect.objectContaining({ retries: 0 }),
    );
  });

  it("retries a transient stream-open failure without streaming", async () => {
    mocks.streamTextWithModelId.mockRejectedValueOnce(
      Object.assign(new Error("OpenAI API error (502)."), { statusCode: 502 }),
    );
    const root = mkdtempSync(join(tmpdir(), "summarize-stream-502-"));
    const filePath = join(root, "input.txt");
    writeFileSync(filePath, "hello world", "utf8");
    const stdout = collectStream();
    const stderr = collectStream();

    await runCli(["--model", "openai/gpt-5.2", "--stream", "on", "--plain", filePath], {
      env: { HOME: root, OPENAI_API_KEY: "test" },
      fetch: async () => {
        throw new Error("unexpected fetch");
      },
      stdout: stdout.stream,
      stderr: stderr.stream,
    });

    expect(stdout.getText()).toContain("fallback summary");
    expect(mocks.streamTextWithModelId).toHaveBeenCalledTimes(1);
    expect(mocks.generateTextWithModelId).toHaveBeenCalledTimes(1);
  });

  it("retries a transient stream event failure before any output", async () => {
    let lastError: unknown = null;
    mocks.streamTextWithModelId.mockResolvedValueOnce({
      textStream: {
        async *[Symbol.asyncIterator]() {
          lastError = { errorMessage: "OpenAI API error (502): bad gateway" };
        },
      },
      canonicalModelId: "openai/gpt-5.2",
      provider: "openai",
      usage: Promise.resolve(null),
      lastError: () => lastError,
    });
    const root = mkdtempSync(join(tmpdir(), "summarize-stream-event-502-"));
    const filePath = join(root, "input.txt");
    writeFileSync(filePath, "hello world", "utf8");
    const stdout = collectStream();
    const stderr = collectStream();

    await runCli(["--model", "openai/gpt-5.2", "--stream", "on", "--plain", filePath], {
      env: { HOME: root, OPENAI_API_KEY: "test" },
      fetch: async () => {
        throw new Error("unexpected fetch");
      },
      stdout: stdout.stream,
      stderr: stderr.stream,
    });

    expect(stdout.getText()).toContain("fallback summary");
    expect(mocks.generateTextWithModelId).toHaveBeenCalledTimes(1);
  });

  it("retries a buffered transient stream failure before output starts", async () => {
    let lastError: unknown = null;
    mocks.streamTextWithModelId.mockResolvedValueOnce({
      textStream: {
        async *[Symbol.asyncIterator]() {
          yield "partial summary";
          lastError = { errorMessage: "OpenAI API error (502): bad gateway" };
        },
      },
      canonicalModelId: "openai/gpt-5.2",
      provider: "openai",
      usage: Promise.resolve(null),
      lastError: () => lastError,
    });
    const root = mkdtempSync(join(tmpdir(), "summarize-stream-partial-502-"));
    const filePath = join(root, "input.txt");
    writeFileSync(filePath, "hello world", "utf8");
    const stdout = collectStream();
    const stderr = collectStream();

    await runCli(["--model", "openai/gpt-5.2", "--stream", "on", "--plain", filePath], {
      env: { HOME: root, OPENAI_API_KEY: "test" },
      fetch: async () => {
        throw new Error("unexpected fetch");
      },
      stdout: stdout.stream,
      stderr: stderr.stream,
    });

    expect(stdout.getText()).toContain("fallback summary");
    expect(stdout.getText()).not.toContain("partial summary");
    expect(mocks.generateTextWithModelId).toHaveBeenCalledTimes(1);
  });

  it("retries a transient stream error reported during final-text resolution", async () => {
    let lastError: unknown = null;
    mocks.streamTextWithModelId.mockResolvedValueOnce({
      textStream: {
        async *[Symbol.asyncIterator]() {
          yield "partial summary";
        },
      },
      canonicalModelId: "openai/gpt-5.2",
      provider: "openai",
      usage: Promise.resolve(null),
      finalText: Promise.resolve().then(() => {
        lastError = { errorMessage: "OpenAI API error (502): bad gateway" };
        return null;
      }),
      lastError: () => lastError,
    });
    const root = mkdtempSync(join(tmpdir(), "summarize-stream-final-502-"));
    const filePath = join(root, "input.txt");
    writeFileSync(filePath, "hello world", "utf8");
    const stdout = collectStream();
    const stderr = collectStream();

    await runCli(["--model", "openai/gpt-5.2", "--stream", "on", "--plain", filePath], {
      env: { HOME: root, OPENAI_API_KEY: "test" },
      fetch: async () => {
        throw new Error("unexpected fetch");
      },
      stdout: stdout.stream,
      stderr: stderr.stream,
    });

    expect(stdout.getText()).toContain("fallback summary");
    expect(stdout.getText()).not.toContain("partial summary");
    expect(mocks.generateTextWithModelId).toHaveBeenCalledTimes(1);
  });

  it("does not retry a transient stream failure after output is flushed", async () => {
    let lastError: unknown = null;
    mocks.streamTextWithModelId.mockResolvedValueOnce({
      textStream: {
        async *[Symbol.asyncIterator]() {
          yield "partial summary\n";
          lastError = { errorMessage: "OpenAI API error (502): bad gateway" };
        },
      },
      canonicalModelId: "openai/gpt-5.2",
      provider: "openai",
      usage: Promise.resolve(null),
      lastError: () => lastError,
    });
    const root = mkdtempSync(join(tmpdir(), "summarize-stream-flushed-502-"));
    const filePath = join(root, "input.txt");
    writeFileSync(filePath, "hello world", "utf8");
    const stdout = collectStream();
    const stderr = collectStream();

    await expect(
      runCli(["--model", "openai/gpt-5.2", "--stream", "on", "--plain", filePath], {
        env: { HOME: root, OPENAI_API_KEY: "test" },
        fetch: async () => {
          throw new Error("unexpected fetch");
        },
        stdout: stdout.stream,
        stderr: stderr.stream,
      }),
    ).rejects.toThrow(/OpenAI API error \(502\)/);

    expect(stdout.getText()).toContain("partial summary");
    expect(mocks.generateTextWithModelId).not.toHaveBeenCalled();
  });
});
