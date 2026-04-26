import type { ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import type { ExecFileFn } from "../src/markitdown.js";
import { runCli } from "../src/run.js";

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

describe("cli --extract with local PDF files", () => {
  it("extracts text from a local PDF using markitdown without LLM", async () => {
    const root = mkdtempSync(join(tmpdir(), "summarize-extract-pdf-"));
    try {
      const pdfPath = join(root, "test.pdf");
      writeFileSync(pdfPath, Buffer.from("%PDF-1.7\n%âãÏÓ\n1 0 obj\n<<>>\nendobj\n", "utf8"));

      const stdout = collectStream();
      const stderr = collectStream();

      const execFileMock = vi.fn(((file, args, _options, callback) => {
        void file;
        void args;
        callback(null, "# Extracted Heading\n\nExtracted PDF content.\n", "");
        return { pid: 123 } as unknown as ChildProcess;
      }) as ExecFileFn);

      await runCli(["--extract", "--plain", pdfPath], {
        env: { HOME: root, UVX_PATH: "uvx" },
        fetch: vi.fn(async () => {
          throw new Error("unexpected fetch — extract mode should not hit network");
        }) as unknown as typeof fetch,
        execFile: execFileMock,
        stdout: stdout.stream,
        stderr: stderr.stream,
      });

      expect(stdout.getText()).toContain("Extracted PDF content.");
      expect(execFileMock).toHaveBeenCalled();
      expect(mocks.streamSimple).not.toHaveBeenCalled();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects --extract on a non-PDF local file with a helpful error", async () => {
    const root = mkdtempSync(join(tmpdir(), "summarize-extract-txt-"));
    try {
      const txtPath = join(root, "notes.txt");
      writeFileSync(txtPath, "Hello world", "utf8");

      await expect(
        runCli(["--extract", "--plain", txtPath], {
          env: { HOME: root },
          fetch: vi.fn(async () => {
            throw new Error("unexpected fetch");
          }) as unknown as typeof fetch,
          stdout: collectStream().stream,
          stderr: collectStream().stream,
        }),
      ).rejects.toThrow(/--extract for local files is only supported for media files/i);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("errors with a helpful message when uvx is not available", async () => {
    const root = mkdtempSync(join(tmpdir(), "summarize-extract-pdf-no-uvx-"));
    try {
      const pdfPath = join(root, "test.pdf");
      writeFileSync(pdfPath, Buffer.from("%PDF-1.7\n%âãÏÓ\n1 0 obj\n<<>>\nendobj\n", "utf8"));

      const failingExecFile = vi.fn(((_file, _args, _options, callback) => {
        callback(new Error("uvx not found"), "", "");
        return { pid: 0 } as unknown as ChildProcess;
      }) as ExecFileFn);

      await expect(
        runCli(["--extract", "--plain", pdfPath], {
          env: { HOME: root },
          fetch: vi.fn(async () => {
            throw new Error("unexpected fetch");
          }) as unknown as typeof fetch,
          execFile: failingExecFile,
          stdout: collectStream().stream,
          stderr: collectStream().stream,
        }),
      ).rejects.toThrow(/uvx|markitdown/i);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
