import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execCliWithInput } from "../cli-exec.js";
import { parsePiOutputFromJsonl } from "../cli-provider-output.js";
import type { CliRunResult, ResolvedCliRunOptions } from "./types.js";

export async function runPiCli(options: ResolvedCliRunOptions): Promise<CliRunResult> {
  let isolatedCwd: string | null = null;
  let promptDir: string | null = null;
  try {
    isolatedCwd = !options.allowTools
      ? await fs.mkdtemp(path.join(tmpdir(), "summarize-pi-"))
      : null;
    promptDir = await fs.mkdtemp(path.join(tmpdir(), "summarize-pi-prompt-"));
    const promptPath = path.join(promptDir, "prompt.txt");
    await fs.writeFile(promptPath, options.prompt, { mode: 0o600 });
    const args = [...options.providerExtraArgs, "--print", "--mode", "json"];
    if (!options.allowTools) args.push("--no-tools");
    args.push(
      "--no-context-files",
      "--no-extensions",
      "--no-skills",
      "--no-session",
      "--thinking",
      "off",
    );
    if (options.systemPrompt) args.push("--system-prompt", options.systemPrompt);
    if (options.requestedModel) args.push("--model", options.requestedModel);
    args.push(`@${promptPath}`);
    const { stdout } = await execCliWithInput({
      execFileImpl: options.execFileImpl,
      cmd: options.binary,
      args,
      input: "",
      timeoutMs: options.timeoutMs,
      env: options.env,
      cwd: isolatedCwd ?? options.cwd,
      signal: options.signal,
    });
    return parsePiOutputFromJsonl(stdout);
  } finally {
    if (promptDir) await fs.rm(promptDir, { recursive: true, force: true }).catch(() => {});
    if (isolatedCwd) await fs.rm(isolatedCwd, { recursive: true, force: true }).catch(() => {});
  }
}
