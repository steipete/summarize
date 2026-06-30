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

function noopStream(): Writable {
  return new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
}

function collectStdout() {
  let text = "";
  const stdout = new Writable({
    write(chunk, _encoding, callback) {
      text += chunk.toString();
      callback();
    },
  });
  return { stdout, getText: () => text };
}

describe("cli auto fallback behavior", () => {
  it("skips models with missing keys (auto)", async () => {
    mocks.completeSimple.mockReset().mockResolvedValue(makeAssistantMessage({ text: "OK" }));

    const html =
      "<!doctype html><html><head><title>Hello</title></head>" +
      `<body><article><p>${"This is a sentence. ".repeat(240)}</p></article></body></html>`;

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.url;
      if (url === "https://example.com") return htmlResponse(html);
      throw new Error(`Unexpected fetch call: ${url}`);
    });

    const tempRoot = mkdtempSync(join(tmpdir(), "summarize-auto-fallback-"));
    mkdirSync(join(tempRoot, ".summarize"), { recursive: true });
    writeFileSync(
      join(tempRoot, ".summarize", "config.json"),
      JSON.stringify({
        model: {
          mode: "auto",
          rules: [
            {
              when: ["website"],
              candidates: ["google/gemini-3-flash-preview", "openai/gpt-5-chat"],
            },
          ],
        },
      }),
      "utf8",
    );

    const out = collectStdout();
    await runCli(
      [
        "--model",
        "auto",
        "--timeout",
        "2s",
        "--max-output-tokens",
        "50",
        "--plain",
        "https://example.com",
      ],
      {
        env: { HOME: tempRoot, OPENAI_API_KEY: "test" },
        fetch: fetchMock as unknown as typeof fetch,
        stdout: out.stdout,
        stderr: noopStream(),
      },
    );

    expect(out.getText().trim()).toBe("OK");
    expect(mocks.completeSimple).toHaveBeenCalledTimes(1);
    const model = mocks.completeSimple.mock.calls[0]?.[0] as { provider?: string };
    expect(model.provider).toBe("openai");
  });

  it("falls back on request errors (auto)", async () => {
    mocks.completeSimple
      .mockReset()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce(makeAssistantMessage({ text: "OK" }));

    const html =
      "<!doctype html><html><head><title>Hello</title></head>" +
      `<body><article><p>${"This is a sentence. ".repeat(240)}</p></article></body></html>`;

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.url;
      if (url === "https://example.com") return htmlResponse(html);
      throw new Error(`Unexpected fetch call: ${url}`);
    });

    const tempRoot = mkdtempSync(join(tmpdir(), "summarize-auto-fallback-"));
    mkdirSync(join(tempRoot, ".summarize"), { recursive: true });
    writeFileSync(
      join(tempRoot, ".summarize", "config.json"),
      JSON.stringify({
        model: {
          mode: "auto",
          rules: [
            {
              when: ["website"],
              candidates: ["openai/gpt-5-chat", "openai/gpt-4.1"],
            },
          ],
        },
      }),
      "utf8",
    );

    const out = collectStdout();
    await runCli(
      [
        "--model",
        "auto",
        "--timeout",
        "2s",
        "--max-output-tokens",
        "50",
        "--plain",
        "https://example.com",
      ],
      {
        env: { HOME: tempRoot, OPENAI_API_KEY: "test" },
        fetch: fetchMock as unknown as typeof fetch,
        stdout: out.stdout,
        stderr: noopStream(),
      },
    );

    expect(out.getText().trim()).toBe("OK");
    expect(mocks.completeSimple).toHaveBeenCalledTimes(2);
  });
});
