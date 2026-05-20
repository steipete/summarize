import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { runCli } from "../src/run.js";
import { makeAssistantMessage, makeTextDeltaStream } from "./helpers/pi-ai-mock.js";

const htmlResponse = (html: string, status = 200) =>
  new Response(html, {
    status,
    headers: { "Content-Type": "text/html" },
  });

function collectStream() {
  let text = "";
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      const value = chunk.toString();
      chunks.push(value);
      text += value;
      callback();
    },
  });
  return { stream, getText: () => text, chunks };
}

const mocks = vi.hoisted(() => ({
  streamSimple: vi.fn(),
  getModel: vi.fn(() => {
    throw new Error("no model");
  }),
}));

vi.mock("@earendil-works/pi-ai", () => ({
  streamSimple: mocks.streamSimple,
  getModel: mocks.getModel,
}));

function writeLiteLlmCache(root: string) {
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
}

async function runStreamedSummary(
  chunks: string[],
  options?: { perfTrace?: boolean; stdoutIsTty?: boolean; writeLiteLlmCatalog?: boolean },
): Promise<{ stderr: string; stdout: string; stdoutChunks: string[] }> {
  mocks.streamSimple.mockReset().mockImplementation(() =>
    makeTextDeltaStream(
      chunks,
      makeAssistantMessage({
        text: chunks.at(-1) ?? "",
        usage: { input: 100, output: 50, totalTokens: 150 },
      }),
    ),
  );

  const root = mkdtempSync(join(tmpdir(), "summarize-stream-merge-"));
  if (options?.writeLiteLlmCatalog !== false) {
    writeLiteLlmCache(root);
  }
  const globalFetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
    throw new Error("unexpected LiteLLM catalog fetch");
  });

  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.url;
    if (url === "https://example.com") {
      return htmlResponse(
        "<!doctype html><html><head><title>Hello</title></head>" +
          "<body><article><p>Hi</p></article></body></html>",
      );
    }
    throw new Error(`Unexpected fetch call: ${url}`);
  });

  const stdout = collectStream();
  if (options?.stdoutIsTty) {
    const stream = stdout.stream as unknown as { isTTY?: boolean; columns?: number };
    stream.isTTY = true;
    stream.columns = 80;
  }
  const stderr = collectStream();

  try {
    await runCli(
      [
        "--model",
        "openai/gpt-5.2",
        "--timeout",
        "2s",
        "--stream",
        "on",
        "--plain",
        "https://example.com",
      ],
      {
        env: {
          HOME: root,
          OPENAI_API_KEY: "test",
          ...(options?.perfTrace ? { SUMMARIZE_PERF_TRACE: "1" } : {}),
          ...(options?.stdoutIsTty ? { NO_COLOR: "1" } : {}),
        },
        fetch: fetchMock as unknown as typeof fetch,
        stdout: stdout.stream,
        stderr: stderr.stream,
      },
    );
  } finally {
    globalFetchSpy.mockRestore();
  }

  return { stdout: stdout.getText(), stderr: stderr.getText(), stdoutChunks: stdout.chunks };
}

describe("cli stream chunk merge", () => {
  beforeEach(() => {
    mocks.streamSimple.mockReset();
  });

  it("avoids duplication when chunks are cumulative buffers", async () => {
    const { stdout: out } = await runStreamedSummary(["Hello", "Hello world", "Hello world!"]);
    expect(out).toBe("Hello world!\n");
  }, 20_000);

  it("keeps delta chunks unchanged", async () => {
    const { stdout: out } = await runStreamedSummary(["Hello ", "world", "!"]);
    expect(out).toBe("Hello world!\n");
  }, 20_000);

  it("writes the first plain stdout chunk before a newline arrives", async () => {
    const { stdout: out, stdoutChunks } = await runStreamedSummary(["Hello", " world\n"], {
      stdoutIsTty: true,
      writeLiteLlmCatalog: false,
    });

    expect(out).toBe("Hello world\n");
    expect(stdoutChunks[0]).toBe("Hello");
    expect(stdoutChunks[1]).toBe(" world\n");
  }, 20_000);

  it("handles mixed delta then cumulative chunks", async () => {
    const { stdout: out } = await runStreamedSummary(["Hello ", "world", "Hello world!!"]);
    expect(out).toBe("Hello world!!\n");
  }, 20_000);

  it("treats near-prefix cumulative chunks as replacements", async () => {
    const { stdout: out } = await runStreamedSummary(["Hello world.", "Hello world!"]);
    expect(out).toBe("Hello world!\n");
  }, 20_000);

  it("ignores regressions where a later chunk is a shorter prefix", async () => {
    const { stdout: out } = await runStreamedSummary(["Hello world", "Hello"]);
    expect(out).toBe("Hello world\n");
  }, 20_000);

  it("merges overlapping suffix/prefix chunks without duplication", async () => {
    const { stdout: out } = await runStreamedSummary(["Hello world", "world!"]);
    expect(out).toBe("Hello world!\n");
  }, 20_000);

  it("treats near-prefix edits as replacements (prefix threshold)", async () => {
    const prev = "abcdefghijklmnopqrst";
    const next = "abcdefghijklmnopqrsu";
    const { stdout: out } = await runStreamedSummary([prev, next]);
    expect(out).toBe(`${next}\n`);
  }, 20_000);

  it("does not fetch the LiteLLM catalog on the fixed-model stream path when cache is missing", async () => {
    const { stdout: out } = await runStreamedSummary(["Hello"], {
      writeLiteLlmCatalog: false,
    });

    expect(out).toBe("Hello\n");
  }, 20_000);

  it("prints an opt-in performance trace with first output timing", async () => {
    const { stderr, stdout } = await runStreamedSummary(["Hello"], {
      perfTrace: true,
      writeLiteLlmCatalog: false,
    });

    expect(stdout).toBe("Hello\n");
    expect(stderr).toContain("[summarize:perf]");
    expect(stderr).toContain("summary:first-delta");
    expect(stderr).toContain("stdout:first-write");
  }, 20_000);
});
