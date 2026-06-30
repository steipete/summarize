import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import type { Api } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { runCli } from "../src/run.js";
import { makeAssistantMessage } from "./helpers/pi-ai-mock.js";

type MockModel = { provider: string; id: string; api: Api; baseUrl?: string };
type MockOptions = {
  signal?: AbortSignal;
  apiKey?: string;
  onPayload?: (payload: unknown) => unknown;
};

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

mocks.completeSimple.mockImplementation(
  async (model: MockModel, _context: unknown, options: MockOptions) =>
    makeAssistantMessage({
      provider: model.provider,
      model: model.id,
      api: model.api,
      text: "OK",
      usage: { input: 1, output: 1, totalTokens: 2 },
      ...(options?.signal?.aborted ? { stopReason: "aborted" } : {}),
    }),
);

vi.mock("@earendil-works/pi-ai/compat", () => ({
  completeSimple: mocks.completeSimple,
  streamSimple: mocks.streamSimple,
  getModel: mocks.getModel,
}));

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

function writeJsonConfig(value: unknown) {
  const root = mkdtempSync(join(tmpdir(), "summarize-config-"));
  mkdirSync(join(root, ".summarize"), { recursive: true });
  writeFileSync(join(root, ".summarize", "config.json"), JSON.stringify(value), "utf8");
  return root;
}

describe("cli LLM provider selection (direct keys)", () => {
  it("uses OpenAI when --model is openai/...", async () => {
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
      env: { OPENAI_API_KEY: "test" },
      fetch: fetchMock as unknown as typeof fetch,
      stdout: out.stdout,
      stderr: new Writable({
        write(_c, _e, cb) {
          cb();
        },
      }),
    });

    expect(out.getText().trim()).toBe("OK");
    const model = mocks.completeSimple.mock.calls[0]?.[0] as { provider?: string };
    expect(model.provider).toBe("openai");
  });

  it("uses Z.AI when --model is zai/...", async () => {
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
    await runCli(["--model", "zai/glm-4.7", "--timeout", "2s", "https://example.com"], {
      env: { Z_AI_API_KEY: "zai-test", OPENAI_API_KEY: "openai-test" },
      fetch: fetchMock as unknown as typeof fetch,
      stdout: out.stdout,
      stderr: new Writable({
        write(_c, _e, cb) {
          cb();
        },
      }),
    });

    expect(out.getText().trim()).toBe("OK");
    const model = mocks.completeSimple.mock.calls[0]?.[0] as {
      provider?: string;
      baseUrl?: string;
    };
    const options = mocks.completeSimple.mock.calls[0]?.[2] as { apiKey?: string };
    expect(model.provider).toBe("zai");
    expect(options.apiKey).toBe("zai-test");
    expect(model.baseUrl).toBe("https://api.z.ai/api/paas/v4");
  });

  it("uses NVIDIA when --model is nvidia/...", async () => {
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
    await runCli(["--model", "nvidia/z-ai/glm5", "--timeout", "2s", "https://example.com"], {
      env: { NVIDIA_API_KEY: "nvidia-test" },
      fetch: fetchMock as unknown as typeof fetch,
      stdout: out.stdout,
      stderr: new Writable({
        write(_c, _e, cb) {
          cb();
        },
      }),
    });

    expect(out.getText().trim()).toBe("OK");
    const model = mocks.completeSimple.mock.calls[0]?.[0] as {
      provider?: string;
      baseUrl?: string;
    };
    const options = mocks.completeSimple.mock.calls[0]?.[2] as { apiKey?: string };
    expect(model.provider).toBe("openai");
    expect(options.apiKey).toBe("nvidia-test");
    expect(model.baseUrl).toBe("https://integrate.api.nvidia.com/v1");
  });

  it("uses MiniMax with separated reasoning when --model is minimax/...", async () => {
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
    await runCli(["--model", "minimax/MiniMax-M3", "--timeout", "2s", "https://example.com"], {
      env: { MINIMAX_API_KEY: "minimax-test" },
      fetch: fetchMock as unknown as typeof fetch,
      stdout: out.stdout,
      stderr: new Writable({
        write(_c, _e, cb) {
          cb();
        },
      }),
    });

    expect(out.getText().trim()).toBe("OK");
    const model = mocks.completeSimple.mock.calls[0]?.[0] as MockModel;
    const options = mocks.completeSimple.mock.calls[0]?.[2] as MockOptions;
    expect(model).toMatchObject({
      provider: "minimax",
      api: "openai-completions",
      baseUrl: "https://api.minimax.io/v1",
    });
    expect(options.apiKey).toBe("minimax-test");
    expect(await Promise.resolve(options.onPayload?.({ stream: false }))).toEqual({
      stream: false,
      reasoning_split: true,
    });
  });

  it("uses Google when --model is google/...", async () => {
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
    await runCli(["--model", "google/gemini-2.0-flash", "--timeout", "2s", "https://example.com"], {
      env: { GOOGLE_GENERATIVE_AI_API_KEY: "test" },
      fetch: fetchMock as unknown as typeof fetch,
      stdout: out.stdout,
      stderr: new Writable({
        write(_c, _e, cb) {
          cb();
        },
      }),
    });

    expect(out.getText().trim()).toBe("OK");
    const model = mocks.completeSimple.mock.calls[0]?.[0] as { provider?: string };
    expect(model.provider).toBe("google");
  });

  it("uses xAI when --model is xai/...", async () => {
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
    await runCli(
      ["--model", "xai/grok-4-fast-non-reasoning", "--timeout", "2s", "https://example.com"],
      {
        env: { XAI_API_KEY: "test" },
        fetch: fetchMock as unknown as typeof fetch,
        stdout: out.stdout,
        stderr: new Writable({
          write(_c, _e, cb) {
            cb();
          },
        }),
      },
    );

    expect(out.getText().trim()).toBe("OK");
    const model = mocks.completeSimple.mock.calls[0]?.[0] as { provider?: string };
    expect(model.provider).toBe("xai");
  });

  it("uses Anthropic when --model is anthropic/...", async () => {
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
    await runCli(
      ["--model", "anthropic/claude-sonnet-4-5", "--timeout", "2s", "https://example.com"],
      {
        env: { ANTHROPIC_API_KEY: "test" },
        fetch: fetchMock as unknown as typeof fetch,
        stdout: out.stdout,
        stderr: new Writable({
          write(_c, _e, cb) {
            cb();
          },
        }),
      },
    );

    expect(out.getText().trim()).toBe("OK");
    const model = mocks.completeSimple.mock.calls[0]?.[0] as { provider?: string };
    expect(model.provider).toBe("anthropic");
  });

  it("applies provider baseUrl overrides from env", async () => {
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
    await runCli(
      ["--model", "anthropic/claude-sonnet-4-5", "--timeout", "2s", "https://example.com"],
      {
        env: {
          ANTHROPIC_API_KEY: "test",
          ANTHROPIC_BASE_URL: "https://anthropic-proxy.example.com",
        },
        fetch: fetchMock as unknown as typeof fetch,
        stdout: out.stdout,
        stderr: new Writable({
          write(_c, _e, cb) {
            cb();
          },
        }),
      },
    );

    expect(out.getText().trim()).toBe("OK");
    const model = mocks.completeSimple.mock.calls[0]?.[0] as {
      provider?: string;
      baseUrl?: string;
    };
    expect(model.provider).toBe("anthropic");
    expect(model.baseUrl).toBe("https://anthropic-proxy.example.com");
  });

  it("applies provider baseUrl overrides from config when env is absent", async () => {
    mocks.completeSimple.mockClear();

    const home = writeJsonConfig({
      anthropic: { baseUrl: "https://anthropic-proxy.example.com" },
      openai: { baseUrl: "https://openai-proxy.example.com/v1" },
    });

    const html =
      "<!doctype html><html><head><title>Hello</title></head>" +
      "<body><article><p>Hi</p></article></body></html>";

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.url;
      if (url === "https://example.com") return htmlResponse(html);
      throw new Error(`Unexpected fetch call: ${url}`);
    });

    const out = collectStdout();
    await runCli(
      ["--model", "anthropic/claude-sonnet-4-5", "--timeout", "2s", "https://example.com"],
      {
        env: { HOME: home, ANTHROPIC_API_KEY: "test" },
        fetch: fetchMock as unknown as typeof fetch,
        stdout: out.stdout,
        stderr: new Writable({
          write(_c, _e, cb) {
            cb();
          },
        }),
      },
    );

    const model = mocks.completeSimple.mock.calls[0]?.[0] as {
      provider?: string;
      baseUrl?: string;
    };
    expect(model.provider).toBe("anthropic");
    expect(model.baseUrl).toBe("https://anthropic-proxy.example.com");

    mocks.completeSimple.mockClear();
    await runCli(["--model", "openai/gpt-5-chat", "--timeout", "2s", "https://example.com"], {
      env: { HOME: home, OPENAI_API_KEY: "test" },
      fetch: fetchMock as unknown as typeof fetch,
      stdout: out.stdout,
      stderr: new Writable({
        write(_c, _e, cb) {
          cb();
        },
      }),
    });

    const openaiModel = mocks.completeSimple.mock.calls[0]?.[0] as {
      provider?: string;
      baseUrl?: string;
    };
    expect(openaiModel.provider).toBe("openai");
    expect(openaiModel.baseUrl).toBe("https://openai-proxy.example.com/v1");
  });
});
