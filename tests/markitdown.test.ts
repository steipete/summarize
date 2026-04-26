import { describe, expect, it, vi } from "vitest";
import { convertToMarkdownWithMarkitdown, type ExecFileFn } from "../src/markitdown.js";

function execFileOk(expectCmd: string, stdoutText: string) {
  return vi.fn((file, _args, _opts, cb) => {
    expect(file).toBe(expectCmd);
    cb(null, stdoutText, "");
  }) as unknown as ExecFileFn;
}

describe("markitdown", () => {
  it("runs uvx with markitdown[all] and infers .pdf when media type is pdf", async () => {
    const execFileMock = vi.fn((file, args, _opts, cb) => {
      expect(file).toBe("uvx");
      expect(args.slice(0, 3)).toEqual(["--from", "markitdown[all]", "markitdown"]);
      const filePath = String(args[3]);
      expect(filePath.endsWith(".pdf")).toBe(true);
      cb(null, "# ok\n", "");
    }) as unknown as ExecFileFn;

    await expect(
      convertToMarkdownWithMarkitdown({
        bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46]),
        filenameHint: null,
        mediaTypeHint: "application/pdf",
        uvxCommand: null,
        timeoutMs: 1000,
        env: {},
        execFileImpl: execFileMock,
      }),
    ).resolves.toMatchObject({ markdown: expect.stringContaining("# ok"), usedOcr: false });
  });

  it("uses filename extension when present (no media type hint)", async () => {
    const execFileMock = vi.fn((file, args, _opts, cb) => {
      expect(file).toBe("uvx");
      const filePath = String(args[3]);
      expect(filePath.endsWith(".docx")).toBe(true);
      cb(null, "# ok\n", "");
    }) as unknown as ExecFileFn;

    await expect(
      convertToMarkdownWithMarkitdown({
        bytes: new Uint8Array([1, 2, 3]),
        filenameHint: "My File.docx",
        mediaTypeHint: null,
        uvxCommand: null,
        timeoutMs: 1000,
        env: {},
        execFileImpl: execFileMock,
      }),
    ).resolves.toMatchObject({ markdown: expect.stringContaining("# ok"), usedOcr: false });
  });

  it("infers .html when media type is html and filename has no extension", async () => {
    const execFileMock = vi.fn((file, args, _opts, cb) => {
      expect(file).toBe("uvx");
      const filePath = String(args[3]);
      expect(filePath.endsWith(".html")).toBe(true);
      cb(null, "# ok\n", "");
    }) as unknown as ExecFileFn;

    await expect(
      convertToMarkdownWithMarkitdown({
        bytes: new TextEncoder().encode("<html></html>"),
        filenameHint: "page",
        mediaTypeHint: "text/html",
        uvxCommand: null,
        timeoutMs: 1000,
        env: {},
        execFileImpl: execFileMock,
      }),
    ).resolves.toMatchObject({ markdown: expect.stringContaining("# ok"), usedOcr: false });
  });

  it("falls back to .bin when no filename extension or known media type exists", async () => {
    const execFileMock = vi.fn((file, args, _opts, cb) => {
      expect(file).toBe("uvx");
      const filePath = String(args[3]);
      expect(filePath.endsWith(".bin")).toBe(true);
      cb(null, "# ok\n", "");
    }) as unknown as ExecFileFn;

    await expect(
      convertToMarkdownWithMarkitdown({
        bytes: new Uint8Array([1, 2, 3]),
        filenameHint: "blob",
        mediaTypeHint: "application/octet-stream",
        uvxCommand: null,
        timeoutMs: 1000,
        env: {},
        execFileImpl: execFileMock,
      }),
    ).resolves.toMatchObject({ markdown: expect.stringContaining("# ok"), usedOcr: false });
  });

  it("throws when markitdown returns empty output", async () => {
    const execFileMock = execFileOk("uvx", "   \n");
    await expect(
      convertToMarkdownWithMarkitdown({
        bytes: new Uint8Array([1, 2, 3]),
        filenameHint: "x.pdf",
        mediaTypeHint: "application/pdf",
        uvxCommand: null,
        timeoutMs: 1000,
        env: {},
        execFileImpl: execFileMock,
      }),
    ).rejects.toThrow(/returned empty output/i);
  });

  it("includes stderr text when the subprocess fails", async () => {
    const execFileMock = vi.fn((_file, _args, _opts, cb) => {
      const err = new Error("Command failed");
      cb(err, "", "boom\n");
    }) as unknown as ExecFileFn;

    await expect(
      convertToMarkdownWithMarkitdown({
        bytes: new Uint8Array([1, 2, 3]),
        filenameHint: "x.pdf",
        mediaTypeHint: "application/pdf",
        uvxCommand: null,
        timeoutMs: 1000,
        env: {},
        execFileImpl: execFileMock,
      }),
    ).rejects.toThrow(/boom/i);
  });

  it("converts stdout/stderr buffers to utf8 strings", async () => {
    const execFileMock = vi.fn((_file, _args, _opts, cb) => {
      cb(null, Buffer.from("# ok\n", "utf8"), Buffer.from("", "utf8"));
    }) as unknown as ExecFileFn;

    await expect(
      convertToMarkdownWithMarkitdown({
        bytes: new Uint8Array([1, 2, 3]),
        filenameHint: "x.pdf",
        mediaTypeHint: "application/pdf",
        uvxCommand: null,
        timeoutMs: 1000,
        env: {},
        execFileImpl: execFileMock,
      }),
    ).resolves.toMatchObject({ markdown: expect.stringContaining("# ok"), usedOcr: false });
  });

  it("keeps error message when stderr is empty (buffer)", async () => {
    const execFileMock = vi.fn((_file, _args, _opts, cb) => {
      const err = new Error("Command failed");
      cb(err, Buffer.from("", "utf8"), Buffer.from("   \n", "utf8"));
    }) as unknown as ExecFileFn;

    await expect(
      convertToMarkdownWithMarkitdown({
        bytes: new Uint8Array([1, 2, 3]),
        filenameHint: "x.pdf",
        mediaTypeHint: "application/pdf",
        uvxCommand: null,
        timeoutMs: 1000,
        env: {},
        execFileImpl: execFileMock,
      }),
    ).rejects.toThrow(/^Command failed$/);
  });

  it("deriveUvCommand: absolute path /usr/local/bin/uvx → /usr/local/bin/uv", async () => {
    let callCount = 0;
    const execFileMock = vi.fn(((file, _args, _opts, cb) => {
      callCount++;
      if (callCount === 1) {
        expect(file).toBe("/usr/local/bin/uvx");
        cb(null, "", ""); // image-based PDF, triggers OCR path
      } else {
        expect(file).toBe("/usr/local/bin/uv");
        cb(null, "# ocr\n", "");
      }
    }) as unknown as ExecFileFn);

    await expect(
      convertToMarkdownWithMarkitdown({
        bytes: new Uint8Array([1, 2, 3]),
        filenameHint: "x.pdf",
        mediaTypeHint: "application/pdf",
        uvxCommand: "/usr/local/bin/uvx",
        timeoutMs: 1000,
        env: { OPENAI_API_KEY: "test" },
        execFileImpl: execFileMock,
        ocrFallback: true,
      }),
    ).resolves.toMatchObject({ usedOcr: true });
  });

  it("deriveUvCommand: uvx.exe → uv.exe (Windows extension preserved)", async () => {
    let callCount = 0;
    const execFileMock = vi.fn(((file, _args, _opts, cb) => {
      callCount++;
      if (callCount === 1) {
        expect(file).toBe("uvx.exe");
        cb(null, "", "");
      } else {
        expect(file).toBe("uv.exe");
        cb(null, "# ocr\n", "");
      }
    }) as unknown as ExecFileFn);

    await expect(
      convertToMarkdownWithMarkitdown({
        bytes: new Uint8Array([1, 2, 3]),
        filenameHint: "x.pdf",
        mediaTypeHint: "application/pdf",
        uvxCommand: "uvx.exe",
        timeoutMs: 1000,
        env: { OPENAI_API_KEY: "test" },
        execFileImpl: execFileMock,
        ocrFallback: true,
      }),
    ).resolves.toMatchObject({ usedOcr: true });
  });

  it("deriveUvCommand: non-matching wrapper name is passed through unchanged", async () => {
    let callCount = 0;
    const execFileMock = vi.fn(((file, _args, _opts, cb) => {
      callCount++;
      if (callCount === 1) {
        expect(file).toBe("my-uvx-wrapper");
        cb(null, "", "");
      } else {
        expect(file).toBe("my-uvx-wrapper"); // not matching ^uvx...$ — left as-is
        cb(null, "# ocr\n", "");
      }
    }) as unknown as ExecFileFn);

    await expect(
      convertToMarkdownWithMarkitdown({
        bytes: new Uint8Array([1, 2, 3]),
        filenameHint: "x.pdf",
        mediaTypeHint: "application/pdf",
        uvxCommand: "my-uvx-wrapper",
        timeoutMs: 1000,
        env: { OPENAI_API_KEY: "test" },
        execFileImpl: execFileMock,
        ocrFallback: true,
      }),
    ).resolves.toMatchObject({ usedOcr: true });
  });
});
