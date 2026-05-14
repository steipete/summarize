import type { ExecFileOptions } from "node:child_process";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

export type ExecFileFn = typeof import("node:child_process").execFile;

function deriveUvCommand(uvxCmd: string): string {
  const dir = path.dirname(uvxCmd);
  const base = path.basename(uvxCmd);
  const uvBase = base.replace(/^uvx(\..*)?$/, "uv$1");
  return dir === "." ? uvBase : path.join(dir, uvBase);
}

const OCR_HELPER_SCRIPT = `\
import base64
import io
import os
import re
import sys

import fitz
import openai


def is_page_headers_only(markdown: str) -> bool:
    lines = [line.strip() for line in markdown.splitlines() if line.strip()]
    return bool(lines) and all(re.match(r"^#{1,6}\\s+Page\\s+\\d+\\s*$", line, re.I) for line in lines)


def is_meaningful(markdown: str) -> bool:
    return bool(markdown.strip()) and not is_page_headers_only(markdown)


def ocr_image(client: openai.OpenAI, model: str, image_stream: io.BytesIO) -> str:
    image_stream.seek(0)
    data_uri = "data:image/png;base64," + base64.b64encode(image_stream.read()).decode("utf-8")
    response = client.chat.completions.create(
        model=model,
        messages=[
            {
                "role": "user",
                "content": [
                    {
                        "type": "text",
                        "text": "Extract all text from this image. Return only the extracted text, preserving the original order. Do not add commentary.",
                    },
                    {"type": "image_url", "image_url": {"url": data_uri}},
                ],
            }
        ],
    )
    return (response.choices[0].message.content or "").strip()


def ocr_pdf_pages(file_path: str, client: openai.OpenAI, model: str) -> str:
    parts = []
    errors = []
    dpi = int(os.environ.get("MARKITDOWN_OCR_DPI", "150"))
    doc = fitz.open(file_path)
    try:
        for page_index in range(doc.page_count):
            page_num = page_index + 1
            page = doc[page_index]
            pix = page.get_pixmap(matrix=fitz.Matrix(dpi / 72, dpi / 72), alpha=False)
            image_stream = io.BytesIO(pix.tobytes("png"))
            try:
                text = ocr_image(client, model, image_stream)
                if text:
                    parts.append(f"\\n## Page {page_num}\\n\\n*[Image OCR]\\n{text}\\n[End OCR]*")
            except Exception as exc:
                errors.append(f"page {page_num}: {type(exc).__name__}: {exc}")
    finally:
        doc.close()
    if not parts and errors:
        print("OCR failed: " + "; ".join(errors), file=sys.stderr)
        raise SystemExit(2)
    return "\\n\\n".join(parts).strip()


file_path = sys.argv[1]
api_key = os.environ["OPENAI_API_KEY"]
model = os.environ.get("MARKITDOWN_OCR_MODEL", "gpt-4o-mini")

if file_path.lower().endswith(".pdf"):
    client = openai.OpenAI(api_key=api_key, timeout=60.0, max_retries=1)
    markdown = ocr_pdf_pages(file_path, client, model)
    print(markdown)
    raise SystemExit(0)

from markitdown import MarkItDown

client = openai.OpenAI(api_key=api_key, timeout=60.0, max_retries=1)
md = MarkItDown(enable_plugins=True, llm_client=client, llm_model=model)
result = md.convert(file_path)
markdown = result.text_content or ""

print(markdown)
`;

function isPageHeadersOnly(markdown: string): boolean {
  const lines = markdown
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.length > 0 && lines.every((line) => /^#{1,6}\s+Page\s+\d+\s*$/i.test(line));
}

function isMeaningfulMarkdown(markdown: string): boolean {
  return markdown.trim().length > 0 && !isPageHeadersOnly(markdown);
}

function guessExtension({
  filenameHint,
  mediaType,
}: {
  filenameHint: string | null;
  mediaType: string | null;
}): string {
  const ext = filenameHint ? path.extname(filenameHint).toLowerCase() : "";
  if (ext) return ext;
  if (mediaType === "text/html" || mediaType === "application/xhtml+xml") return ".html";
  if (mediaType === "application/pdf") return ".pdf";
  return ".bin";
}

async function execFileText(
  execFileImpl: ExecFileFn,
  cmd: string,
  args: string[],
  options: ExecFileOptions,
): Promise<{ stdout: string; stderr: string }> {
  return await new Promise((resolve, reject) => {
    execFileImpl(cmd, args, options, (error, stdout, stderr) => {
      if (error) {
        const stderrText = typeof stderr === "string" ? stderr : stderr.toString("utf8");
        const message = stderrText.trim()
          ? `${error.message}: ${stderrText.trim()}`
          : error.message;
        reject(new Error(message, { cause: error }));
        return;
      }
      const stdoutText = typeof stdout === "string" ? stdout : stdout.toString("utf8");
      const stderrText = typeof stderr === "string" ? stderr : stderr.toString("utf8");
      resolve({ stdout: stdoutText, stderr: stderrText });
    });
  });
}

export async function convertToMarkdownWithMarkitdown({
  bytes,
  filenameHint,
  mediaTypeHint,
  uvxCommand,
  timeoutMs,
  env,
  execFileImpl,
  ocrFallback = false,
}: {
  bytes: Uint8Array;
  filenameHint: string | null;
  mediaTypeHint: string | null;
  uvxCommand?: string | null;
  timeoutMs: number;
  env: Record<string, string | undefined>;
  execFileImpl: ExecFileFn;
  ocrFallback?: boolean;
}): Promise<{ markdown: string; usedOcr: boolean }> {
  const dir = await fs.mkdtemp(path.join(tmpdir(), "summarize-markitdown-"));
  const ext = guessExtension({ filenameHint, mediaType: mediaTypeHint });
  const base = (filenameHint ? path.basename(filenameHint, path.extname(filenameHint)) : "input")
    .replaceAll(/[^\w.-]+/g, "-")
    .slice(0, 64);
  const filePath = path.join(dir, `${base}${ext}`);
  const uvx = uvxCommand && uvxCommand.trim().length > 0 ? uvxCommand.trim() : "uvx";
  const from = "markitdown[all]";
  const execOptions = {
    timeout: timeoutMs,
    env: { ...process.env, ...env },
    maxBuffer: 50 * 1024 * 1024,
  };

  try {
    await fs.writeFile(filePath, bytes);
    const { stdout } = await execFileText(
      execFileImpl,
      uvx,
      ["--from", from, "markitdown", filePath],
      execOptions,
    );
    const markdown = stdout.trim();
    if (!ocrFallback) {
      if (!markdown) throw new Error("markitdown returned empty output");
      return { markdown, usedOcr: false };
    }
    if (isMeaningfulMarkdown(markdown)) {
      return { markdown, usedOcr: false };
    }

    if (execOptions.env.OPENAI_API_KEY) {
      const uv = deriveUvCommand(uvx);
      const scriptPath = path.join(dir, "ocr_helper.py");
      await fs.writeFile(scriptPath, OCR_HELPER_SCRIPT, "utf8");
      const { stdout: ocrStdout } = await execFileText(
        execFileImpl,
        uv,
        [
          "run",
          "--with",
          from,
          "--with",
          "markitdown-ocr",
          "--with",
          "openai",
          "--no-project",
          scriptPath,
          filePath,
        ],
        execOptions,
      );
      const ocrMarkdown = ocrStdout.trim();
      if (isMeaningfulMarkdown(ocrMarkdown)) {
        return { markdown: ocrMarkdown, usedOcr: true };
      }
    }

    throw new Error("markitdown returned empty output");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}
