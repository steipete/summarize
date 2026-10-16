import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { runCli } from "../src/run.js";
import { makeAssistantMessage } from "./helpers/pi-ai-mock.js";
import { captureStream as collectStream } from "./helpers/streams.js";

type MockModel = { provider: string; id: string; api: Api };

const mocks = vi.hoisted(() => ({
  completeSimple: vi.fn(),
  streamSimple: vi.fn(),
  getModel: vi.fn(() => {
    throw new Error("no model");
  }),
}));

mocks.completeSimple.mockImplementation(async (model: MockModel) =>
  makeAssistantMessage({
    text: "OK",
    provider: model.provider,
    model: model.id,
    api: model.api,
    usage: { input: 1, output: 1, totalTokens: 2 },
  }),
);

vi.mock("@earendil-works/pi-ai/compat", () => ({
  completeSimple: mocks.completeSimple,
  streamSimple: mocks.streamSimple,
  getModel: mocks.getModel,
}));

describe("metrics model label", () => {
  it("keeps openrouter/… prefix in the finish line", async () => {
    const root = mkdtempSync(join(tmpdir(), "summarize-openrouter-label-"));
    const cacheDir = join(root, ".summarize", "cache");
    mkdirSync(cacheDir, { recursive: true });

    writeFileSync(
      join(cacheDir, "litellm-model_prices_and_context_window.json"),
      JSON.stringify({
        "openai/xiaomi/mimo-v2-flash:free": { input_cost_per_token: 0, output_cost_per_token: 0 },
      }),
      "utf8",
    );
    writeFileSync(
      join(cacheDir, "litellm-model_prices_and_context_window.meta.json"),
      JSON.stringify({ fetchedAtMs: Date.now() }),
      "utf8",
    );

    const html =
      "<!doctype html><html><head><title>Hello</title></head>" +
      "<body><article><p>Hi</p></article></body></html>";

    let requestBody: Record<string, unknown> | null = null;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.url;
      if (url === "https://example.com") {
        return new Response(html, { status: 200, headers: { "Content-Type": "text/html" } });
      }
      if (url === "https://openrouter.ai/api/v1/chat/completions") {
        requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return new Response(
          JSON.stringify({
            choices: [{ message: { content: "OK" } }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      throw new Error(`Unexpected fetch call: ${url}`);
    });

    const stdout = collectStream();
    const stderr = collectStream();

    await runCli(
      [
        "--model",
        "openrouter/xiaomi/mimo-v2-flash:free",
        "--metrics",
        "on",
        "--stream",
        "off",
        "--timeout",
        "2s",
        "https://example.com",
      ],
      {
        env: { HOME: root, OPENROUTER_API_KEY: "test" },
        fetch: fetchMock as unknown as typeof fetch,
        stdout: stdout.stream,
        stderr: stderr.stream,
      },
    );

    expect(stderr.getText()).toContain("openrouter/xiaomi/mimo-v2-flash:free");
    expect(stderr.getText()).not.toContain("openai/xiaomi/mimo-v2-flash:free");
    expect(requestBody).toMatchObject({ model: "xiaomi/mimo-v2-flash:free" });
  });
});
