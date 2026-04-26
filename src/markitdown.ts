import type { ExecFileOptions } from "node:child_process";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

export type ExecFileFn = typeof import("node:child_process").execFile;

/**
 * Derives the `uv` command from a `uvx` command path.
 * e.g. "uvx" → "uv", "/usr/local/bin/uvx" → "/usr/local/bin/uv",
 * "uvx.exe" → "uv.exe".
 * Non-matching basenames (e.g. a custom wrapper) are passed through
 * unchanged — the caller is responsible for ensuring the command
 * accepts `uv run` arguments in that case.
 */
function deriveUvCommand(uvxCmd: string): string {
  const dir = path.dirname(uvxCmd);
  const base = path.basename(uvxCmd);
  const uvBase = base.replace(/^uvx(\..*)?$/, "uv$1");
  return dir === "." ? uvBase : path.join(dir, uvBase);
}

/**
 * Python script that invokes markitdown via its Python API, wiring an OpenAI
 * client so the markitdown-ocr plugin can call the vision API.
 *
 * Cost note: each OCR call uses the OpenAI vision API (gpt-4o-mini by default).
 * Typical cost is ~$0.001–$0.01 per page depending on image resolution.
 */
const OCR_HELPER_SCRIPT = `\
import sys, os
import openai
from markitdown import MarkItDown

file_path = sys.argv[1]
client = openai.OpenAI(api_key=os.environ["OPENAI_API_KEY"])
model = os.environ.get("MARKITDOWN_OCR_MODEL", "gpt-4o-mini")
md = MarkItDown(enable_plugins=True, llm_client=client, llm_model=model)
result = md.convert(file_path)
print(result.text_content)
`;

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

    // First attempt: standard markitdown
    const { stdout } = await execFileText(execFileImpl, uvx, ["--from", from, "markitdown", filePath], execOptions);
    const markdown = stdout.trim();
    if (markdown) return { markdown, usedOcr: false };

    // Second attempt: OCR fallback via markitdown Python API with LLM vision wiring.
    // Requires OPENAI_API_KEY; uses gpt-4o-mini by default (override with MARKITDOWN_OCR_MODEL).
    if (ocrFallback && execOptions.env?.["OPENAI_API_KEY"]) {
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
      if (ocrMarkdown) return { markdown: ocrMarkdown, usedOcr: true };
    }

    throw new Error("markitdown returned empty output");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}
