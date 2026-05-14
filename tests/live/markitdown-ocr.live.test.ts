import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { convertToMarkdownWithMarkitdown } from "../../src/markitdown.js";

const LIVE = process.env.SUMMARIZE_LIVE_TEST === "1";
const HAS_OPENAI_KEY = !!process.env.OPENAI_API_KEY;

const FIXTURE_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "fixtures",
  "image-only.pdf",
);

(LIVE && HAS_OPENAI_KEY ? describe : describe.skip)("live markitdown OCR fallback", () => {
  it("extracts text from an image-only PDF using vision API", async () => {
    const bytes = new Uint8Array(await fs.readFile(FIXTURE_PATH));
    const { markdown, usedOcr } = await convertToMarkdownWithMarkitdown({
      bytes,
      filenameHint: "image-only.pdf",
      mediaTypeHint: "application/pdf",
      timeoutMs: 120_000,
      env: { OPENAI_API_KEY: process.env.OPENAI_API_KEY! },
      execFileImpl: execFile,
      ocrFallback: true,
    });
    expect(usedOcr).toBe(true);
    expect(markdown).toMatch(/OCR LIVE SMOKE/i);
  }, 120_000);
});
