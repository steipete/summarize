import type { ExecFileOptions } from "node:child_process";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

export type ExecFileFn = typeof import("node:child_process").execFile;

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

    // Second attempt: OCR fallback via markitdown-ocr plugin
    if (ocrFallback) {
      const { stdout: ocrStdout } = await execFileText(
        execFileImpl,
        uvx,
        ["--from", from, "--with", "markitdown-ocr", "markitdown", "--use-plugins", filePath],
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
