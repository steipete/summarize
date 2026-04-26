import type { ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import type { ExecFileFn } from "../src/markitdown.js";
import { runCli } from "../src/run.js";
import { makeAssistantMessage, makeTextDeltaStream } from "./helpers/pi-ai-mock.js";

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
  completeSimple: vi.fn(),
  getModel: vi.fn(() => {
    throw new Error("no model");
  }),
}));

vi.mock("@mariozechner/pi-ai", () => ({
  streamSimple: mocks.streamSimple,
  completeSimple: mocks.completeSimple,
  getModel: mocks.getModel,
}));

const FAKE_PDF = Buffer.from("%PDF-1.7\n%âãÏÓ\n1 0 obj\n<<>>\nendobj\n", "utf8");

describe("markitdown OCR fallback for image-based PDFs", () => {
  it("--extract: finish line shows 'markitdown+ocr' when OCR fallback was used", async () => {
    const root = mkdtempSync(join(tmpdir(), "summarize-ocr-label-"));
    try {
      const pdfPath = join(root, "scanned.pdf");
      writeFileSync(pdfPath, FAKE_PDF);

      const stderr = collectStream();
      let callCount = 0;

      const execFileMock = vi.fn(((file, _args, _options, callback) => {
        callCount++;
        if (callCount === 1) {
          expect(file).toBe("uvx");
          callback(null, "## Page 1\n\n## Page 2\n", ""); // page-headers-only
        } else {
          callback(null, "# OCR Result\n\nExtracted text.\n", "");
        }
        return { pid: 123 } as unknown as ChildProcess;
      }) as ExecFileFn);

      await runCli(["--extract", "--metrics", "on", pdfPath], {
        env: { HOME: root, UVX_PATH: "uvx", OPENAI_API_KEY: "test-key" },
        fetch: vi.fn(async () => {
          throw new Error("unexpected fetch");
        }) as unknown as typeof fetch,
        execFile: execFileMock,
        stdout: collectStream().stream,
        stderr: stderr.stream,
      });

      expect(stderr.getText()).toContain("markitdown+ocr");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("--extract: retries with markitdown-ocr when first call returns empty, outputs OCR content", async () => {
    const root = mkdtempSync(join(tmpdir(), "summarize-ocr-extract-"));
    try {
      const pdfPath = join(root, "scanned.pdf");
      writeFileSync(pdfPath, FAKE_PDF);

      const stdout = collectStream();
      const stderr = collectStream();
      let callCount = 0;

      let capturedScriptContent: string | undefined;
      const execFileMock = vi.fn(((file, args, _options, callback) => {
        callCount++;
        if (callCount === 1) {
          // First call: standard markitdown via uvx — returns page headers only (real image-based PDF behavior)
          expect(file).toBe("uvx");
          callback(null, "## Page 1\n\n## Page 2\n", "");
        } else {
          // Second call: uv run ocr_helper.py — returns OCR content
          expect(file).toBe("uv");
          expect(args).toContain("run");
          expect(args).toContain("--with");
          expect(args).toContain("markitdown-ocr");
          expect(args).not.toContain("python3"); // uv runs the script directly
          // Read the generated helper script before the temp dir is cleaned up
          const scriptPath = (args as string[]).find((a) => a.endsWith(".py"));
          if (scriptPath) capturedScriptContent = readFileSync(scriptPath, "utf8");
          callback(null, "# OCR Heading\n\nOCR extracted text.\n", "");
        }
        return { pid: 123 } as unknown as ChildProcess;
      }) as ExecFileFn);

      await runCli(["--extract", "--plain", pdfPath], {
        env: { HOME: root, UVX_PATH: "uvx", OPENAI_API_KEY: "test-key" },
        fetch: vi.fn(async () => {
          throw new Error("unexpected fetch");
        }) as unknown as typeof fetch,
        execFile: execFileMock,
        stdout: stdout.stream,
        stderr: stderr.stream,
      });

      expect(execFileMock).toHaveBeenCalledTimes(2);
      expect(stdout.getText()).toContain("OCR extracted text.");
      expect(mocks.streamSimple).not.toHaveBeenCalled();
      // Verify the helper script enables plugins — guards against future regressions
      expect(capturedScriptContent).toContain("enable_plugins=True");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("--extract: throws when both standard and OCR calls return empty", async () => {
    const root = mkdtempSync(join(tmpdir(), "summarize-ocr-empty-"));
    try {
      const pdfPath = join(root, "empty.pdf");
      writeFileSync(pdfPath, FAKE_PDF);

      const execFileMock = vi.fn(((_file, _args, _options, callback) => {
        callback(null, "", "");
        return { pid: 123 } as unknown as ChildProcess;
      }) as ExecFileFn);

      await expect(
        runCli(["--extract", "--plain", pdfPath], {
          env: { HOME: root, UVX_PATH: "uvx", OPENAI_API_KEY: "test-key" },
          fetch: vi.fn(async () => {
            throw new Error("unexpected fetch");
          }) as unknown as typeof fetch,
          execFile: execFileMock,
          stdout: collectStream().stream,
          stderr: collectStream().stream,
        }),
      ).rejects.toThrow(/markitdown returned empty output/i);

      expect(execFileMock).toHaveBeenCalledTimes(2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("--extract: does not retry OCR when OPENAI_API_KEY is absent", async () => {
    const root = mkdtempSync(join(tmpdir(), "summarize-ocr-no-key-"));
    try {
      const pdfPath = join(root, "empty.pdf");
      writeFileSync(pdfPath, FAKE_PDF);

      const execFileMock = vi.fn(((_file, _args, _options, callback) => {
        callback(null, "", "");
        return { pid: 123 } as unknown as ChildProcess;
      }) as ExecFileFn);

      await expect(
        runCli(["--extract", "--plain", pdfPath], {
          env: { HOME: root, UVX_PATH: "uvx", OPENAI_API_KEY: undefined }, // explicitly absent
          fetch: vi.fn(async () => {
            throw new Error("unexpected fetch");
          }) as unknown as typeof fetch,
          execFile: execFileMock,
          stdout: collectStream().stream,
          stderr: collectStream().stream,
        }),
      ).rejects.toThrow(/markitdown returned empty output/i);

      // OCR branch requires OPENAI_API_KEY — only one call made
      expect(execFileMock).toHaveBeenCalledTimes(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("--extract: does NOT retry OCR when first call returns real text content", async () => {
    const root = mkdtempSync(join(tmpdir(), "summarize-ocr-real-content-"));
    try {
      const pdfPath = join(root, "text.pdf");
      writeFileSync(pdfPath, FAKE_PDF);

      const execFileMock = vi.fn(((_file, _args, _options, callback) => {
        // Returns real content (page header + actual text) — OCR must NOT trigger
        callback(null, "## Page 1\n\nActual book text here.\n", "");
        return { pid: 123 } as unknown as ChildProcess;
      }) as ExecFileFn);

      const stdout = collectStream();
      await runCli(["--extract", "--plain", pdfPath], {
        env: { HOME: root, UVX_PATH: "uvx", OPENAI_API_KEY: "test-key" },
        fetch: vi.fn(async () => {
          throw new Error("unexpected fetch");
        }) as unknown as typeof fetch,
        execFile: execFileMock,
        stdout: stdout.stream,
        stderr: collectStream().stream,
      });

      // Real content returned on first call — no OCR retry
      expect(execFileMock).toHaveBeenCalledTimes(1);
      expect(stdout.getText()).toContain("Actual book text here.");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("summarize: falls back to OCR when preprocessing an image-based PDF", async () => {
    mocks.streamSimple.mockClear();
    mocks.streamSimple.mockImplementationOnce(() =>
      makeTextDeltaStream(
        ["Summary from OCR."],
        makeAssistantMessage({
          text: "Summary from OCR.",
          usage: { input: 10, output: 5, totalTokens: 15 },
        }),
      ),
    );

    const root = mkdtempSync(join(tmpdir(), "summarize-ocr-summarize-"));
    try {
      const { mkdirSync } = await import("node:fs");
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

      const pdfPath = join(root, "scanned.pdf");
      writeFileSync(pdfPath, FAKE_PDF);

      const stdout = collectStream();
      const stderr = collectStream();
      let callCount = 0;

      const execFileMock = vi.fn(((file, args, _options, callback) => {
        callCount++;
        if (callCount === 1) {
          // First call: standard markitdown via uvx — returns empty (image-based PDF)
          expect(file).toBe("uvx");
          callback(null, "", "");
        } else {
          // Second call: uv run ocr_helper.py — returns OCR content
          expect(file).toBe("uv");
          expect(args).toContain("run");
          expect(args).toContain("markitdown-ocr");
          expect(args).not.toContain("python3"); // uv runs the script directly
          callback(null, "# OCR Content\n\nScanned page text.\n", "");
        }
        return { pid: 123 } as unknown as ChildProcess;
      }) as ExecFileFn);

      await runCli(
        ["--model", "openai/gpt-5.2", "--stream", "on", "--plain", "--preprocess", "always", pdfPath],
        {
          env: { HOME: root, OPENAI_API_KEY: "test", UVX_PATH: "uvx" },
          fetch: vi.fn(async () => {
            throw new Error("unexpected fetch");
          }) as unknown as typeof fetch,
          execFile: execFileMock,
          stdout: stdout.stream,
          stderr: stderr.stream,
        },
      );

      expect(execFileMock).toHaveBeenCalledTimes(2);
      expect(mocks.streamSimple).toHaveBeenCalledTimes(1);
      // Verify OCR content was passed to the LLM
      const callArg = mocks.streamSimple.mock.calls[0]?.[1] as {
        messages?: Array<{ role: string; content: unknown }>;
      };
      expect(String(callArg.messages?.[0]?.content ?? "")).toContain("Scanned page text.");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
