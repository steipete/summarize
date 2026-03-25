import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import type { Api } from "@mariozechner/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { runCli } from "../src/run.js";
import { makeAssistantMessage } from "./helpers/pi-ai-mock.js";

type MockModel = { provider: string; id: string; api: Api };

const htmlResponse = (html: string, status = 200) =>
  new Response(html, {
    status,
    headers: { "Content-Type": "text/html" },
  });

const mocks = vi.hoisted(() => ({
  completeSimple: vi.fn(),
  streamSimple: vi.fn(),
  getModel: vi.fn(() => {
    throw new Error("no model");
  }),
}));

mocks.completeSimple.mockImplementation(async (model: MockModel) =>
  makeAssistantMessage({ text: "OK", provider: model.provider, model: model.id, api: model.api }),
);

vi.mock("@mariozechner/pi-ai", () => ({
  completeSimple: mocks.completeSimple,
  streamSimple: mocks.streamSimple,
  getModel: mocks.getModel,
}));

function noopStream(): Writable {
  return new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
}

function captureStream() {
  let text = "";
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      text += chunk.toString();
      callback();
    },
  });
  return { stream, getText: () => text };
}

function resolveFetchUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

describe("cli config precedence", () => {
  it("uses config file model when --model and SUMMARIZE_MODEL are absent", async () => {
    mocks.completeSimple.mockClear();

    const html =
      "<!doctype html><html><head><title>Hello</title></head>" +
      "<body><article><p>Hi</p></article></body></html>";

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = resolveFetchUrl(input);
      if (url === "https://example.com") return htmlResponse(html);
      throw new Error(`Unexpected fetch call: ${url}`);
    });

    const tempRoot = mkdtempSync(join(tmpdir(), "summarize-cli-config-"));
    const configPath = join(tempRoot, ".summarize", "config.json");
    mkdirSync(join(tempRoot, ".summarize"), { recursive: true });
    writeFileSync(configPath, JSON.stringify({ model: { id: "openai/gpt-5.2" } }), "utf8");

    await runCli(["--timeout", "2s", "https://example.com"], {
      env: { HOME: tempRoot, OPENAI_API_KEY: "test" },
      fetch: fetchMock as unknown as typeof fetch,
      stdout: noopStream(),
      stderr: noopStream(),
    });

    expect(mocks.completeSimple).toHaveBeenCalledTimes(1);
  });

  it("uses config file model preset when --model and SUMMARIZE_MODEL are absent", async () => {
    mocks.completeSimple.mockClear();

    const html =
      "<!doctype html><html><head><title>Hello</title></head>" +
      "<body><article><p>Hi</p></article></body></html>";

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = resolveFetchUrl(input);
      if (url === "https://example.com") return htmlResponse(html);
      throw new Error(`Unexpected fetch call: ${url}`);
    });

    const tempRoot = mkdtempSync(join(tmpdir(), "summarize-cli-config-"));
    const configPath = join(tempRoot, ".summarize", "config.json");
    mkdirSync(join(tempRoot, ".summarize"), { recursive: true });
    writeFileSync(
      configPath,
      JSON.stringify({
        model: "mypreset",
        models: {
          mypreset: {
            mode: "auto",
            rules: [{ candidates: ["openai/gpt-5.2"] }],
          },
        },
      }),
      "utf8",
    );

    const stdout = captureStream();

    await runCli(
      ["--timeout", "2s", "--extract", "--format", "text", "--json", "https://example.com"],
      {
        env: { HOME: tempRoot },
        fetch: fetchMock as unknown as typeof fetch,
        stdout: stdout.stream,
        stderr: noopStream(),
      },
    );

    const parsed = JSON.parse(stdout.getText()) as { input: { model: string } };
    expect(parsed.input.model).toBe("mypreset");

    // --extract means no LLM calls; ensure we didn't try to init a provider.
    expect(mocks.completeSimple).toHaveBeenCalledTimes(0);
  });

  it("prefers SUMMARIZE_MODEL over config file", async () => {
    mocks.completeSimple.mockClear();

    const html =
      "<!doctype html><html><head><title>Hello</title></head>" +
      "<body><article><p>Hi</p></article></body></html>";

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = resolveFetchUrl(input);
      if (url === "https://example.com") return htmlResponse(html);
      throw new Error(`Unexpected fetch call: ${url}`);
    });

    const tempRoot = mkdtempSync(join(tmpdir(), "summarize-cli-config-"));
    const configPath = join(tempRoot, ".summarize", "config.json");
    mkdirSync(join(tempRoot, ".summarize"), { recursive: true });
    writeFileSync(
      configPath,
      JSON.stringify({ model: { id: "xai/grok-4-fast-non-reasoning" } }),
      "utf8",
    );

    const stdout = captureStream();

    await runCli(
      ["--timeout", "2s", "--extract", "--format", "text", "--json", "https://example.com"],
      {
        env: { HOME: tempRoot, SUMMARIZE_MODEL: "openai/gpt-5.2" },
        fetch: fetchMock as unknown as typeof fetch,
        stdout: stdout.stream,
        stderr: noopStream(),
      },
    );

    const parsed = JSON.parse(stdout.getText()) as { input: { model: string } };
    expect(parsed.input.model).toBe("openai/gpt-5.2");

    // --extract means no LLM calls; ensure we didn't try to init a provider.
    expect(mocks.completeSimple).toHaveBeenCalledTimes(0);
  });

  it("uses config file output.length when --length is absent", async () => {
    mocks.completeSimple.mockClear();

    const html =
      "<!doctype html><html><head><title>Hello</title></head>" +
      "<body><article><p>Hi</p></article></body></html>";

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = resolveFetchUrl(input);
      if (url === "https://example.com") return htmlResponse(html);
      throw new Error(`Unexpected fetch call: ${url}`);
    });

    const tempRoot = mkdtempSync(join(tmpdir(), "summarize-cli-config-"));
    const configPath = join(tempRoot, ".summarize", "config.json");
    mkdirSync(join(tempRoot, ".summarize"), { recursive: true });
    writeFileSync(
      configPath,
      JSON.stringify({ model: { id: "openai/gpt-5.2" }, output: { length: "short" } }),
      "utf8",
    );

    const stdout = captureStream();

    await runCli(["--timeout", "2s", "--json", "https://example.com"], {
      env: { HOME: tempRoot, OPENAI_API_KEY: "test" },
      fetch: fetchMock as unknown as typeof fetch,
      stdout: stdout.stream,
      stderr: noopStream(),
    });

    const parsed = JSON.parse(stdout.getText()) as { input: { length: { preset: string } } };
    expect(parsed.input.length).toEqual({ kind: "preset", preset: "short" });
  });

  it("prefers --length over config file output.length", async () => {
    mocks.completeSimple.mockClear();

    const html =
      "<!doctype html><html><head><title>Hello</title></head>" +
      "<body><article><p>Hi</p></article></body></html>";

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = resolveFetchUrl(input);
      if (url === "https://example.com") return htmlResponse(html);
      throw new Error(`Unexpected fetch call: ${url}`);
    });

    const tempRoot = mkdtempSync(join(tmpdir(), "summarize-cli-config-"));
    const configPath = join(tempRoot, ".summarize", "config.json");
    mkdirSync(join(tempRoot, ".summarize"), { recursive: true });
    writeFileSync(
      configPath,
      JSON.stringify({ model: { id: "openai/gpt-5.2" }, output: { length: "short" } }),
      "utf8",
    );

    const stdout = captureStream();

    await runCli(["--timeout", "2s", "--length", "20k", "--json", "https://example.com"], {
      env: { HOME: tempRoot, OPENAI_API_KEY: "test" },
      fetch: fetchMock as unknown as typeof fetch,
      stdout: stdout.stream,
      stderr: noopStream(),
    });

    const parsed = JSON.parse(stdout.getText()) as {
      input: { length: { kind: string; maxCharacters: number } };
    };
    expect(parsed.input.length).toEqual({ kind: "chars", maxCharacters: 20000 });
  });
});
