import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { runCli } from "../src/run.js";
import { makeAssistantMessage, makeTextDeltaStream } from "./helpers/pi-ai-mock.js";

const htmlResponse = (html: string, status = 200) =>
  new Response(html, {
    status,
    headers: { "Content-Type": "text/html" },
  });

function collectStream() {
  let text = "";
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      text += chunk.toString();
      callback();
    },
  });
  return { stream, getText: () => text };
}

const mocks = vi.hoisted(() => ({
  streamSimple: vi.fn(),
  getModel: vi.fn(() => {
    throw new Error("no model");
  }),
}));

vi.mock("@earendil-works/pi-ai/compat", () => ({
  streamSimple: mocks.streamSimple,
  getModel: mocks.getModel,
}));

describe("cli markdown reference links", () => {
  it("streams without re-rendering earlier lines when reference definitions arrive", async () => {
    mocks.streamSimple.mockImplementation(() =>
      makeTextDeltaStream(
        ["Here is a link: [Example][1]\n\n", "[1]: https://example.com\n"],
        makeAssistantMessage({
          text: "Here is a link: [Example][1]\n\n[1]: https://example.com\n",
          usage: { input: 100, output: 50, totalTokens: 150 },
        }),
      ),
    );
    mocks.streamSimple.mockClear();

    const root = mkdtempSync(join(tmpdir(), "summarize-md-links-"));
    const cacheDir = join(root, ".summarize", "cache");
    mkdirSync(cacheDir, { recursive: true });

    writeFileSync(
      join(cacheDir, "litellm-model_prices_and_context_window.json"),
      JSON.stringify({
        "gpt-5.2": { input_cost_per_token: 0.00000175, output_cost_per_token: 0.000014 },
      }),
      "utf8",
    );
    writeFileSync(
      join(cacheDir, "litellm-model_prices_and_context_window.meta.json"),
      JSON.stringify({ fetchedAtMs: Date.now() }),
      "utf8",
    );

    const globalFetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      throw new Error("unexpected LiteLLM catalog fetch");
    });

    const html =
      "<!doctype html><html><head><title>Hello</title></head>" +
      "<body><article><p>Hi</p></article></body></html>";

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.url;
      if (url === "https://example.com") return htmlResponse(html);
      throw new Error(`Unexpected fetch call: ${url}`);
    });

    const stdout = collectStream();
    (stdout.stream as unknown as { isTTY?: boolean; columns?: number }).isTTY = true;
    (stdout.stream as unknown as { columns?: number }).columns = 80;
    const stderr = collectStream();

    await runCli(
      ["--model", "openai/gpt-5.2", "--timeout", "2s", "--stream", "auto", "https://example.com"],
      {
        env: { HOME: root, OPENAI_API_KEY: "test" },
        fetch: fetchMock as unknown as typeof fetch,
        stdout: stdout.stream,
        stderr: stderr.stream,
      },
    );

    const out = stdout.getText();
    expect(out).toContain("https://example.com");
    expect(out).toContain("[1]: https://example.com");
    expect(out.split("Here is a link:").length - 1).toBe(1);

    globalFetchSpy.mockRestore();
  });

  it("materializes inline Markdown links so URLs remain clickable", async () => {
    mocks.streamSimple.mockImplementationOnce(() =>
      makeTextDeltaStream(
        ["Inline link: [Example](https://inline.example.com)\n"],
        makeAssistantMessage({
          text: "Inline link: [Example](https://inline.example.com)\n",
          usage: { input: 100, output: 50, totalTokens: 150 },
        }),
      ),
    );

    const root = mkdtempSync(join(tmpdir(), "summarize-md-links-"));
    const cacheDir = join(root, ".summarize", "cache");
    mkdirSync(cacheDir, { recursive: true });

    writeFileSync(
      join(cacheDir, "litellm-model_prices_and_context_window.json"),
      JSON.stringify({
        "gpt-5.2": { input_cost_per_token: 0.00000175, output_cost_per_token: 0.000014 },
      }),
      "utf8",
    );
    writeFileSync(
      join(cacheDir, "litellm-model_prices_and_context_window.meta.json"),
      JSON.stringify({ fetchedAtMs: Date.now() }),
      "utf8",
    );

    const globalFetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      throw new Error("unexpected LiteLLM catalog fetch");
    });

    const html =
      "<!doctype html><html><head><title>Hello</title></head>" +
      "<body><article><p>Hi</p></article></body></html>";

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.url;
      if (url === "https://example.com") return htmlResponse(html);
      throw new Error(`Unexpected fetch call: ${url}`);
    });

    const stdout = collectStream();
    (stdout.stream as unknown as { isTTY?: boolean; columns?: number }).isTTY = true;
    (stdout.stream as unknown as { columns?: number }).columns = 80;
    const stderr = collectStream();

    await runCli(
      ["--model", "openai/gpt-5.2", "--timeout", "2s", "--stream", "auto", "https://example.com"],
      {
        env: { HOME: root, OPENAI_API_KEY: "test" },
        fetch: fetchMock as unknown as typeof fetch,
        stdout: stdout.stream,
        stderr: stderr.stream,
      },
    );

    const out = stdout.getText();
    expect(out).toContain("https://inline.example.com");

    globalFetchSpy.mockRestore();
  });

  it("does not rewrite links inside fenced code blocks", async () => {
    mocks.streamSimple.mockImplementationOnce(() =>
      makeTextDeltaStream(
        [
          "Outside: [Example](https://outside.example.com)\n\n",
          "```txt\n",
          "Inside: [Nope](https://inside.example.com)\n",
          "```\n",
        ],
        makeAssistantMessage({
          text: "Outside: [Example](https://outside.example.com)\n\n```txt\nInside: [Nope](https://inside.example.com)\n```\n",
          usage: { input: 100, output: 50, totalTokens: 150 },
        }),
      ),
    );

    const root = mkdtempSync(join(tmpdir(), "summarize-md-links-"));
    const cacheDir = join(root, ".summarize", "cache");
    mkdirSync(cacheDir, { recursive: true });

    writeFileSync(
      join(cacheDir, "litellm-model_prices_and_context_window.json"),
      JSON.stringify({
        "gpt-5.2": { input_cost_per_token: 0.00000175, output_cost_per_token: 0.000014 },
      }),
      "utf8",
    );
    writeFileSync(
      join(cacheDir, "litellm-model_prices_and_context_window.meta.json"),
      JSON.stringify({ fetchedAtMs: Date.now() }),
      "utf8",
    );

    const globalFetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      throw new Error("unexpected LiteLLM catalog fetch");
    });

    const html =
      "<!doctype html><html><head><title>Hello</title></head>" +
      "<body><article><p>Hi</p></article></body></html>";

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.url;
      if (url === "https://example.com") return htmlResponse(html);
      throw new Error(`Unexpected fetch call: ${url}`);
    });

    const stdout = collectStream();
    (stdout.stream as unknown as { isTTY?: boolean; columns?: number }).isTTY = true;
    (stdout.stream as unknown as { columns?: number }).columns = 80;
    const stderr = collectStream();

    await runCli(
      ["--model", "openai/gpt-5.2", "--timeout", "2s", "--stream", "auto", "https://example.com"],
      {
        env: { HOME: root, OPENAI_API_KEY: "test" },
        fetch: fetchMock as unknown as typeof fetch,
        stdout: stdout.stream,
        stderr: stderr.stream,
      },
    );

    const out = stdout.getText();
    expect(out).toContain("https://outside.example.com");

    globalFetchSpy.mockRestore();
  });
});
