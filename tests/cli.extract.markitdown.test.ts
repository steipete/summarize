import { Writable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import type { ExecFileFn } from "../src/markitdown.js";
import { runCli } from "../src/run.js";

describe("cli --extract --format md (markitdown fallback)", () => {
  it("converts HTML to Markdown via markitdown when no LLM keys are configured", async () => {
    const html =
      "<!doctype html><html><head><title>Ok</title></head>" +
      "<body><article><h1>Title</h1><p>Hello</p></article></body></html>";

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.url;
      if (url === "https://example.com") {
        return new Response(html, { status: 200, headers: { "Content-Type": "text/html" } });
      }
      throw new Error(`Unexpected fetch call: ${url}`);
    });

    const execFileMock = vi.fn((file, args, _opts, cb) => {
      expect(file).toBe("uvx");
      expect(args.slice(0, 3)).toEqual(["--from", "markitdown[all]", "markitdown"]);
      cb(null, "# Converted\\n\\nHello\\n", "");
    });

    let stdoutText = "";
    const stdout = new Writable({
      write(chunk, _encoding, callback) {
        stdoutText += chunk.toString();
        callback();
      },
    });

    await runCli(["--extract", "--format", "md", "https://example.com"], {
      env: { UVX_PATH: "uvx" },
      fetch: fetchMock as unknown as typeof fetch,
      execFile: execFileMock as unknown as ExecFileFn,
      stdout,
      stderr: new Writable({
        write(_chunk, _encoding, callback) {
          callback();
        },
      }),
    });

    expect(execFileMock).toHaveBeenCalledTimes(1);
    expect(stdoutText).toContain("# Converted");
  });

  it("falls back gracefully when markitdown returns empty (no OCR retry for URL path)", async () => {
    // When markitdown returns empty for a URL, the error is caught inside the link-preview
    // pipeline and the flow falls back to readability/raw text. This exercises the
    // ocrFallback=false branch in convertToMarkdownWithMarkitdown.
    const html =
      "<!doctype html><html><head><title>Ok</title></head>" +
      "<body><article><h1>Title</h1><p>Hello world</p></article></body></html>";

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.url;
      if (url === "https://example.com") {
        return new Response(html, { status: 200, headers: { "Content-Type": "text/html" } });
      }
      throw new Error(`Unexpected fetch call: ${url}`);
    });

    const execFileMock = vi.fn(((_file, _args, _opts, cb) => {
      cb(null, "", "");
    }) as unknown as ExecFileFn);

    let stdoutText = "";
    const stdout = new Writable({
      write(chunk, _encoding, callback) {
        stdoutText += chunk.toString();
        callback();
      },
    });

    // Should resolve (not throw) — error is caught internally and falls back to text
    await runCli(["--extract", "--format", "md", "https://example.com"], {
      env: { UVX_PATH: "uvx" },
      fetch: fetchMock as unknown as typeof fetch,
      execFile: execFileMock,
      stdout,
      stderr: new Writable({ write(_c, _e, cb) { cb(); } }),
    });

    // markitdown was tried exactly once — no OCR retry (ocrFallback=false for URL path)
    expect(execFileMock).toHaveBeenCalledTimes(1);
    // Falls back to readable text content
    expect(stdoutText).toContain("Hello world");
  });
});
