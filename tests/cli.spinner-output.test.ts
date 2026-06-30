import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { runCli } from "../src/run.js";
import { makeAssistantMessage, makeTextDeltaStream } from "./helpers/pi-ai-mock.js";

const mocks = vi.hoisted(() => ({
  streamSimple: vi.fn(),
  completeSimple: vi.fn(),
  getModel: vi.fn(() => {
    throw new Error("no model");
  }),
}));

vi.mock("@earendil-works/pi-ai/compat", () => ({
  streamSimple: mocks.streamSimple,
  completeSimple: mocks.completeSimple,
  getModel: mocks.getModel,
}));

mocks.streamSimple.mockImplementation(() => {
  throw new Error("should not be called");
});
mocks.completeSimple.mockImplementation(() => {
  throw new Error("should not be called");
});

function collectStream({ isTTY }: { isTTY: boolean }) {
  let text = "";
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      text += chunk.toString();
      callback();
    },
  });
  (stream as unknown as { isTTY?: boolean }).isTTY = isTTY;
  (stream as unknown as { columns?: number }).columns = 120;
  return { stream, getText: () => text };
}

function stripOsc(text: string): string {
  // OSC ... ST
  let out = "";
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch !== "\u001b" || text[i + 1] !== "]") {
      out += ch;
      continue;
    }

    i += 2;
    while (i < text.length) {
      const c = text[i];
      if (c === "\u0007") break;
      if (c === "\u001b" && text[i + 1] === "\\") {
        i += 1;
        break;
      }
      i += 1;
    }
  }
  return out;
}

function stripCsi(text: string): string {
  // Remove CSI sequences we don't simulate here (cursor show/hide, SGR, etc).
  let out = "";
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch !== "\u001b" || text[i + 1] !== "[") {
      out += ch;
      continue;
    }

    i += 2;
    while (i < text.length) {
      const c = text[i];
      if ((c >= "A" && c <= "Z") || (c >= "a" && c <= "z")) break;
      i += 1;
    }
  }
  return out;
}

function applyCarriageReturnAndClearLine(text: string): string {
  // Minimal terminal model:
  // - \r resets current line.
  // - CSI 2K clears current line.
  const CSI_2K = "\u001b[2K";
  let currentLine = "";
  const lines: string[] = [];

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === "\n") {
      lines.push(currentLine);
      currentLine = "";
      continue;
    }
    if (ch === "\r") {
      currentLine = "";
      continue;
    }
    if (text.startsWith(CSI_2K, i)) {
      currentLine = "";
      i += CSI_2K.length - 1;
      continue;
    }
    currentLine += ch;
  }
  if (currentLine.length > 0) lines.push(currentLine);
  return lines.join("\n");
}

// Deterministic spinner: write the initial text once and emulate line clearing.
vi.mock("../src/tty/spinner.js", () => ({
  startSpinner: (opts: { text: string; stream: NodeJS.WritableStream; enabled: boolean }) => {
    if (opts.enabled) opts.stream.write(`- ${opts.text}`);
    const clear = () => opts.stream.write("\r\u001b[2K");
    return {
      stop() {},
      clear,
      pause: clear,
      refresh() {},
      resume() {},
      stopAndClear: clear,
      setText() {},
    };
  },
}));

describe("cli spinner output", () => {
  it('clears the "Loading file" spinner line (no scrollback junk) and includes file size', async () => {
    const root = mkdtempSync(join(tmpdir(), "summarize-spinner-file-"));
    const pdfPath = join(root, "test.pdf");
    const buf = Buffer.alloc(1536, 0);
    buf.write("%PDF-1.7\n", 0, "utf8");
    writeFileSync(pdfPath, buf);

    const stdout = collectStream({ isTTY: false });
    const stderr = collectStream({ isTTY: true });

    await expect(
      runCli(
        ["--stream", "off", "--model", "xai/grok-4-fast-non-reasoning", "--timeout", "2s", pdfPath],
        {
          env: { HOME: root, XAI_API_KEY: "test", TERM: "xterm-256color" },
          fetch: vi.fn(async () => {
            throw new Error("unexpected fetch");
          }) as unknown as typeof fetch,
          stdout: stdout.stream,
          stderr: stderr.stream,
        },
      ),
    ).rejects.toThrow(/uvx\/markitdown/i);

    const rawErr = stderr.getText();
    const plainErr = stripCsi(stripOsc(rawErr));
    expect(plainErr).toContain("Loading file (1.5 KB)");
    expect(rawErr).toContain("\r\u001b[2K");

    const visibleErr = applyCarriageReturnAndClearLine(plainErr);
    expect(visibleErr).not.toMatch(/Loading file/i);
    // When calling `runCli` directly, errors are thrown (not printed). We only assert
    // that the spinner line is cleared and does not pollute scrollback.
  });

  it('clears the "Fetching website" spinner line (no scrollback junk)', async () => {
    const root = mkdtempSync(join(tmpdir(), "summarize-spinner-web-"));
    const stdout = collectStream({ isTTY: false });
    const stderr = collectStream({ isTTY: true });

    await runCli(["--extract", "--format", "text", "--timeout", "2s", "https://example.com"], {
      env: { HOME: root, TERM: "xterm-256color" },
      fetch: vi.fn(async () => {
        return new Response("<html><body><h1>Example</h1></body></html>", {
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      }) as unknown as typeof fetch,
      stdout: stdout.stream,
      stderr: stderr.stream,
    });

    const rawErr = stderr.getText();
    expect(rawErr).toContain("Fetching website");
    expect(rawErr).not.toContain("Transcript");
    expect(rawErr).toContain("\r\u001b[2K");

    const visibleErr = applyCarriageReturnAndClearLine(stripCsi(stripOsc(rawErr)));
    expect(visibleErr).not.toMatch(/Fetching website/i);
  });

  it("switches OSC progress to indeterminate for summarizing", async () => {
    vi.useRealTimers();
    const root = mkdtempSync(join(tmpdir(), "summarize-spinner-osc-"));
    const stdout = collectStream({ isTTY: true });
    const stderr = collectStream({ isTTY: true });

    await runCli(["--stream", "off", "--timeout", "2s", "https://example.com"], {
      env: { HOME: root, TERM_PROGRAM: "wezterm", TERM: "xterm-256color" },
      fetch: vi.fn(async () => {
        return new Response("<html><body><h1>Example</h1></body></html>", {
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      }) as unknown as typeof fetch,
      stdout: stdout.stream,
      stderr: stderr.stream,
    });

    const rawErr = stderr.getText();
    expect(rawErr).toContain("\u001b]9;4;3;;Summarizing");
  }, 15_000);

  it('clears the "Summarizing" spinner line before streaming output', async () => {
    mocks.streamSimple.mockImplementationOnce(() =>
      makeTextDeltaStream(
        ["\nHello", " world\n"],
        makeAssistantMessage({
          text: "\nHello world\n",
          usage: { input: 10, output: 5, totalTokens: 15 },
        }),
      ),
    );

    const root = mkdtempSync(join(tmpdir(), "summarize-spinner-stream-"));
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

    const stdout = collectStream({ isTTY: true });
    const stderr = collectStream({ isTTY: true });
    try {
      const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input.url;
        if (url === "https://example.com") {
          return new Response("<html><body><h1>Example</h1></body></html>", {
            status: 200,
            headers: { "content-type": "text/html; charset=utf-8" },
          });
        }
        throw new Error(`Unexpected fetch call: ${url}`);
      });

      await runCli(
        ["--model", "openai/gpt-5.2", "--stream", "on", "--timeout", "2s", "https://example.com"],
        {
          env: { HOME: root, OPENAI_API_KEY: "test", TERM: "xterm-256color" },
          fetch: fetchMock as unknown as typeof fetch,
          stdout: stdout.stream,
          stderr: stderr.stream,
        },
      );
    } finally {
      globalFetchSpy.mockRestore();
    }

    const rawErr = stderr.getText();
    expect(rawErr).toContain("Fetching website");
    expect(rawErr).toContain("\r\u001b[2K");

    const visibleErr = applyCarriageReturnAndClearLine(stripCsi(stripOsc(rawErr)));
    expect(visibleErr).not.toMatch(/Fetching website/);
  });
});
