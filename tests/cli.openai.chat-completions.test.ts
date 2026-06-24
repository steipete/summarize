import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import type { Api } from "@earendil-works/pi-ai";
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

vi.mock("@earendil-works/pi-ai/compat", () => ({
  completeSimple: mocks.completeSimple,
  streamSimple: mocks.streamSimple,
  getModel: mocks.getModel,
}));

const silentStderr = new Writable({
  write(_chunk, _encoding, callback) {
    callback();
  },
});

const collectStdout = () => {
  let text = "";
  const stdout = new Writable({
    write(chunk, _encoding, callback) {
      text += chunk.toString();
      callback();
    },
  });
  return { stdout, getText: () => text };
};

describe("OpenAI chat completions toggle", () => {
  it("forces chat completions via OPENAI_USE_CHAT_COMPLETIONS", async () => {
    mocks.completeSimple.mockClear();

    const html =
      "<!doctype html><html><head><title>Hello</title></head>" +
      "<body><article><p>Hi</p></article></body></html>";

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.url;
      if (url === "https://example.com") return htmlResponse(html);
      throw new Error(`Unexpected fetch call: ${url}`);
    });

    const out = collectStdout();
    await runCli(["--model", "openai/gpt-5-chat", "--timeout", "2s", "https://example.com"], {
      env: { OPENAI_API_KEY: "test", OPENAI_USE_CHAT_COMPLETIONS: "1" },
      fetch: fetchMock as unknown as typeof fetch,
      stdout: out.stdout,
      stderr: silentStderr,
    });

    const model = mocks.completeSimple.mock.calls[0]?.[0] as { api?: string };
    expect(model.api).toBe("openai-completions");
  });

  it("forces chat completions via config", async () => {
    mocks.completeSimple.mockClear();

    const html =
      "<!doctype html><html><head><title>Hello</title></head>" +
      "<body><article><p>Hi</p></article></body></html>";

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.url;
      if (url === "https://example.com") return htmlResponse(html);
      throw new Error(`Unexpected fetch call: ${url}`);
    });

    const tempRoot = mkdtempSync(join(tmpdir(), "summarize-openai-chat-"));
    const configDir = join(tempRoot, ".summarize");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, "config.json"),
      JSON.stringify({ openai: { useChatCompletions: true } }),
      "utf8",
    );

    const out = collectStdout();
    await runCli(["--model", "openai/gpt-5-chat", "--timeout", "2s", "https://example.com"], {
      env: { HOME: tempRoot, OPENAI_API_KEY: "test" },
      fetch: fetchMock as unknown as typeof fetch,
      stdout: out.stdout,
      stderr: silentStderr,
    });

    const model = mocks.completeSimple.mock.calls[0]?.[0] as { api?: string };
    expect(model.api).toBe("openai-completions");
  });
});
