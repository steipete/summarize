import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { streamChatResponse } from "../src/daemon/chat.js";
import { runCliModel } from "../src/llm/cli.js";
import { streamTextWithContext } from "../src/llm/generate-text.js";
import { buildAutoModelAttempts } from "../src/model-auto.js";

vi.mock("../src/llm/cli.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/llm/cli.js")>();
  return {
    ...actual,
    runCliModel: vi.fn(async () => ({ text: "cli hello", usage: null, costUsd: null })),
  };
});

vi.mock("../src/llm/generate-text.js", () => {
  return {
    streamTextWithContext: vi.fn(async () => ({
      textStream: (async function* () {
        yield "hello";
      })(),
      canonicalModelId: "openai/gpt-5-mini",
      provider: "openai",
      usage: Promise.resolve({ promptTokens: 1, completionTokens: 1, totalTokens: 2 }),
      lastError: () => null,
    })),
  };
});

vi.mock("../src/model-auto.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/model-auto.js")>();
  return {
    ...actual,
    buildAutoModelAttempts: vi.fn(),
  };
});

beforeEach(() => {
  vi.mocked(streamTextWithContext).mockClear();
  vi.mocked(buildAutoModelAttempts).mockReset();
  vi.mocked(runCliModel).mockReset();
  vi.mocked(runCliModel).mockResolvedValue({ text: "cli hello", usage: null, costUsd: null });
});

describe("daemon/chat", () => {
  it("uses native model ids when fixed model override is provided", async () => {
    const home = mkdtempSync(join(tmpdir(), "summarize-daemon-chat-"));
    const events: Array<{ event: string }> = [];
    const meta: Array<{ model?: string | null }> = [];

    await streamChatResponse({
      env: { HOME: home, OPENAI_API_KEY: "sk-openai" },
      fetchImpl: fetch,
      session: {
        id: "s1",
        lastMeta: { model: null, modelLabel: null, inputSummary: null, summaryFromCache: null },
      },
      pageUrl: "https://example.com",
      pageTitle: "Example",
      pageContent: "Hello world",
      messages: [{ role: "user", content: "Hi" }],
      modelOverride: "openai/gpt-5-mini",
      pushToSession: (evt) => events.push(evt),
      emitMeta: (patch) => meta.push(patch),
    });

    const calls = (streamTextWithContext as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    expect(calls.length).toBe(1);
    const args = calls[0]?.[0] as { modelId: string; forceOpenRouter?: boolean };
    expect(args.modelId).toBe("openai/gpt-5-mini");
    expect(args.forceOpenRouter).toBe(false);
    expect(meta[0]?.model).toBe("openai/gpt-5-mini");
    expect(events.some((evt) => evt.event === "metrics")).toBe(true);
  });

  it("runs fixed CLI model overrides through the CLI transport", async () => {
    const home = mkdtempSync(join(tmpdir(), "summarize-daemon-chat-cli-fixed-"));
    const events: Array<{ event: string; data?: unknown }> = [];
    const meta: Array<{ model?: string | null }> = [];

    await streamChatResponse({
      env: { HOME: home },
      fetchImpl: fetch,
      session: {
        id: "s-cli-fixed",
        lastMeta: { model: null, modelLabel: null, inputSummary: null, summaryFromCache: null },
      },
      pageUrl: "https://example.com",
      pageTitle: "Example",
      pageContent: "Hello world",
      messages: [{ role: "user", content: "Hi" }],
      modelOverride: "cli/codex/gpt-5.2",
      pushToSession: (evt) => events.push(evt),
      emitMeta: (patch) => meta.push(patch),
    });

    expect(runCliModel).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "codex",
        model: "gpt-5.2",
        allowTools: false,
      }),
    );
    const args = vi.mocked(runCliModel).mock.calls[0]?.[0] as { prompt: string };
    expect(args.prompt).toContain("You are Summarize Chat.");
    expect(args.prompt).toContain("User: Hi");
    expect(vi.mocked(streamTextWithContext).mock.calls.length).toBe(0);
    expect(meta[0]?.model).toBe("cli/codex/gpt-5.2");
    expect(events).toEqual([{ event: "content", data: "cli hello" }, { event: "metrics" }]);
  });

  it("resolves configured OpenCode models before emitting chat metadata", async () => {
    const home = mkdtempSync(join(tmpdir(), "summarize-daemon-chat-opencode-fixed-"));
    const meta: Array<{ model?: string | null }> = [];

    await streamChatResponse({
      env: { HOME: home },
      fetchImpl: fetch,
      configForCli: {
        cli: {
          opencode: {
            model: "openai/gpt-5.4",
          },
        },
      },
      session: {
        id: "s-opencode-fixed",
        lastMeta: { model: null, modelLabel: null, inputSummary: null, summaryFromCache: null },
      },
      pageUrl: "https://example.com",
      pageTitle: "Example",
      pageContent: "Hello world",
      messages: [{ role: "user", content: "Hi" }],
      modelOverride: "cli/opencode",
      pushToSession: () => {},
      emitMeta: (patch) => meta.push(patch),
    });

    expect(runCliModel).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "opencode",
        model: "openai/gpt-5.4",
      }),
    );
    expect(meta[0]?.model).toBe("cli/opencode/openai/gpt-5.4");
  });

  it("routes openrouter overrides through openrouter transport", async () => {
    const home = mkdtempSync(join(tmpdir(), "summarize-daemon-chat-openrouter-"));
    const meta: Array<{ model?: string | null }> = [];

    await streamChatResponse({
      env: { HOME: home, OPENROUTER_API_KEY: "test" },
      fetchImpl: fetch,
      session: {
        id: "s2",
        lastMeta: { model: null, modelLabel: null, inputSummary: null, summaryFromCache: null },
      },
      pageUrl: "https://example.com",
      pageTitle: null,
      pageContent: "Hello world",
      messages: [{ role: "user", content: "Hi" }],
      modelOverride: "openrouter/anthropic/claude-sonnet-4-5",
      pushToSession: () => {},
      emitMeta: (patch) => meta.push(patch),
    });

    const calls = (streamTextWithContext as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    const args = calls[calls.length - 1]?.[0] as { modelId: string; forceOpenRouter?: boolean };
    expect(args.modelId).toBe("openai/anthropic/claude-sonnet-4-5");
    expect(args.forceOpenRouter).toBe(true);
    expect(meta[0]?.model).toBe("openrouter/anthropic/claude-sonnet-4-5");
  });

  it("uses auto model attempts without forcing openrouter", async () => {
    const home = mkdtempSync(join(tmpdir(), "summarize-daemon-chat-auto-"));
    const meta: Array<{ model?: string | null }> = [];

    const attempts = [
      {
        transport: "native" as const,
        userModelId: "openai/gpt-5-mini",
        llmModelId: "openai/gpt-5-mini",
        openrouterProviders: null,
        forceOpenRouter: false,
        requiredEnv: "OPENAI_API_KEY" as const,
        debug: "test",
      },
    ];

    vi.mocked(buildAutoModelAttempts).mockReturnValue(attempts);

    await streamChatResponse({
      env: { HOME: home, OPENAI_API_KEY: "sk-openai" },
      fetchImpl: fetch,
      session: {
        id: "s3",
        lastMeta: { model: null, modelLabel: null, inputSummary: null, summaryFromCache: null },
      },
      pageUrl: "https://example.com",
      pageTitle: null,
      pageContent: "Hello world",
      messages: [{ role: "user", content: "Hi" }],
      modelOverride: null,
      pushToSession: () => {},
      emitMeta: (patch) => meta.push(patch),
    });

    const calls = (streamTextWithContext as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    const args = calls[calls.length - 1]?.[0] as { modelId: string; forceOpenRouter?: boolean };
    expect(args.modelId).toBe("openai/gpt-5-mini");
    expect(args.forceOpenRouter).toBe(false);
    expect(meta[0]?.model).toBe("openai/gpt-5-mini");
  });

  it("accepts legacy OpenRouter env mapping for auto attempts", async () => {
    const home = mkdtempSync(join(tmpdir(), "summarize-daemon-chat-auto-openrouter-"));
    const meta: Array<{ model?: string | null }> = [];

    const attempts = [
      {
        transport: "openrouter" as const,
        userModelId: "openrouter/openai/gpt-5-mini",
        llmModelId: "openai/openai/gpt-5-mini",
        openrouterProviders: null,
        forceOpenRouter: true,
        requiredEnv: "OPENROUTER_API_KEY" as const,
        debug: "test",
      },
    ];

    vi.mocked(buildAutoModelAttempts).mockReturnValue(attempts);

    await streamChatResponse({
      env: {
        HOME: home,
        OPENAI_BASE_URL: "https://openrouter.ai/api/v1",
        OPENAI_API_KEY: "sk-openrouter-via-openai",
      },
      fetchImpl: fetch,
      session: {
        id: "s4",
        lastMeta: { model: null, modelLabel: null, inputSummary: null, summaryFromCache: null },
      },
      pageUrl: "https://example.com",
      pageTitle: null,
      pageContent: "Hello world",
      messages: [{ role: "user", content: "Hi" }],
      modelOverride: null,
      pushToSession: () => {},
      emitMeta: (patch) => meta.push(patch),
    });

    const calls = (streamTextWithContext as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    const args = calls[calls.length - 1]?.[0] as { modelId: string; forceOpenRouter?: boolean };
    expect(args.modelId).toBe("openai/openai/gpt-5-mini");
    expect(args.forceOpenRouter).toBe(true);
    expect(meta[0]?.model).toBe("openrouter/openai/gpt-5-mini");
  });

  it("falls back to CLI auto attempts when no API-key model is available", async () => {
    const home = mkdtempSync(join(tmpdir(), "summarize-daemon-chat-cli-auto-"));
    const meta: Array<{ model?: string | null }> = [];
    const events: Array<{ event: string; data?: unknown }> = [];

    vi.mocked(buildAutoModelAttempts).mockReturnValue([
      {
        transport: "cli" as const,
        userModelId: "cli/codex/gpt-5.2",
        llmModelId: null,
        openrouterProviders: null,
        forceOpenRouter: false,
        requiredEnv: "CLI_CODEX" as const,
        debug: "cli fallback",
      },
    ]);

    await streamChatResponse({
      env: { HOME: home },
      fetchImpl: fetch,
      session: {
        id: "s-cli-auto",
        lastMeta: { model: null, modelLabel: null, inputSummary: null, summaryFromCache: null },
      },
      pageUrl: "https://example.com",
      pageTitle: null,
      pageContent: "Hello world",
      messages: [{ role: "user", content: "Hi" }],
      modelOverride: null,
      pushToSession: (evt) => events.push(evt),
      emitMeta: (patch) => meta.push(patch),
    });

    expect(runCliModel).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "codex",
        model: "gpt-5.2",
      }),
    );
    expect(vi.mocked(streamTextWithContext).mock.calls.length).toBe(0);
    expect(meta[0]?.model).toBe("cli/codex/gpt-5.2");
    expect(events).toEqual([{ event: "content", data: "cli hello" }, { event: "metrics" }]);
  });
});
