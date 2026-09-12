import { beforeEach, describe, expect, it, vi } from "vitest";
import { createLlmMarkdownConverters } from "../src/llm/markdown-converters.js";

const { generate } = vi.hoisted(() => ({ generate: vi.fn() }));
vi.mock("../src/llm/generate-text.js", () => ({ generateTextWithModelId: generate }));

const options = {
  modelId: "openai/gpt-5.2",
  xaiApiKey: null,
  googleApiKey: null,
  openaiApiKey: "test",
  anthropicApiKey: null,
  openrouterApiKey: null,
  fetchImpl: globalThis.fetch,
};
const input = {
  url: "https://example.com",
  title: "Example",
  siteName: "Example site",
  source: "YouTube",
  html: "<h1>Hello</h1>",
  transcript: "SPEAKER: Hello everyone.",
  timeoutMs: 2000,
};
const result = {
  text: "# Converted",
  canonicalModelId: "openai/gpt-5.2",
  provider: "openai",
  usage: null,
};

beforeEach(() => generate.mockReset().mockResolvedValue(result));

describe.each(["html", "transcript"] as const)("%s Markdown conversion", (kind) => {
  it("preserves source-specific instructions and source metadata", async () => {
    const converter = createLlmMarkdownConverters(options)[kind];
    expect(await converter(input)).toBe("# Converted");
    expect(generate).toHaveBeenCalledTimes(1);
    const request = generate.mock.calls[0][0];
    expect(request.modelId).toBe(options.modelId);
    expect(request.timeoutMs).toBe(2000);
    expect(request.retries).toBe(0);
    expect(request.prompt.userText).toContain("Title: Example");
    if (kind === "html") {
      expect(request.prompt.system).toContain("You convert HTML");
      expect(request.prompt.userText).toContain("URL: https://example.com");
      expect(request.prompt.userText).toContain("Site: Example site");
      expect(request.prompt.userText).toContain("<h1>Hello</h1>");
    } else {
      expect(request.prompt.system).toContain("You convert raw transcripts");
      expect(request.prompt.system).toContain("filler words");
      expect(request.prompt.userText).toContain("Source: YouTube");
      expect(request.prompt.userText).toContain("SPEAKER: Hello everyone.");
    }
  });

  it("retains unknown metadata defaults", async () => {
    await createLlmMarkdownConverters(options)[kind]({
      ...input,
      title: null,
      source: null,
      siteName: null,
    });
    expect(generate.mock.calls[0][0].prompt.userText).toContain("Title: unknown");
    expect(generate.mock.calls[0][0].prompt.userText).toContain(
      kind === "html" ? "Site: unknown" : "Source: unknown",
    );
  });

  it("keeps the 200,000-character input ceiling", async () => {
    const content = `${"A".repeat(200_005)}MARKER`;
    await createLlmMarkdownConverters(options)[kind]({
      ...input,
      html: content,
      transcript: content,
    });
    const prompt = generate.mock.calls[0][0].prompt.userText;
    expect(prompt).toContain("A".repeat(200_000));
    expect(prompt).not.toContain("A".repeat(200_001));
    expect(prompt).not.toContain("MARKER");
  });

  it("forwards configured routing and retries but not unrelated options", async () => {
    const onRetry = vi.fn();
    const routing = {
      forceOpenRouter: true,
      forceChatCompletions: true,
      retries: 2,
      onRetry,
      openaiBaseUrlOverride: "https://openai.example/v1",
      ollamaBaseUrlOverride: "http://localhost:11434/v1",
      anthropicBaseUrlOverride: "https://anthropic.example",
      googleBaseUrlOverride: "https://google.example",
      xaiBaseUrlOverride: "https://xai.example",
      requestOptions: { serviceTier: "fast" as const },
    };
    const converter = createLlmMarkdownConverters({
      ...options,
      ...routing,
      openrouterApiKey: "test-router",
      ...{ openrouter: { providers: ["ignored"] } },
    })[kind];
    await converter(input);
    expect(generate.mock.calls[0][0]).toMatchObject({
      ...routing,
      fetchImpl: options.fetchImpl,
      apiKeys: { openaiApiKey: "test", openrouterApiKey: "test-router" },
    });
    expect(generate.mock.calls[0][0]).not.toHaveProperty("openrouter");
  });

  it("reports usage once and preserves missing-usage handling", async () => {
    const onUsage = vi.fn();
    generate.mockResolvedValueOnce({ ...result, usage: undefined });
    await createLlmMarkdownConverters({ ...options, onUsage })[kind](input);
    expect(onUsage).toHaveBeenCalledExactlyOnceWith({
      model: result.canonicalModelId,
      provider: result.provider,
      usage: kind === "html" ? undefined : null,
    });
  });

  it("propagates generation failure without reporting usage", async () => {
    const onUsage = vi.fn();
    generate.mockRejectedValueOnce(new Error("provider failed"));
    await expect(createLlmMarkdownConverters({ ...options, onUsage })[kind](input)).rejects.toThrow(
      "provider failed",
    );
    expect(onUsage).not.toHaveBeenCalled();
  });
});

it("keeps transcript output-language instructions", async () => {
  await createLlmMarkdownConverters(options).transcript({
    ...input,
    outputLanguage: { kind: "fixed", code: "fr", label: "French" },
  });
  expect(generate.mock.calls[0][0].prompt.system).toContain("Write the answer in French.");
});
