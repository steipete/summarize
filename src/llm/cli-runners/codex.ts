import fs from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { execCliWithInput } from "../cli-exec.js";
import {
  extractCodexTurnFailureFromJsonl,
  parseCodexOutputFromJsonl,
  parseCodexUsageFromJsonl,
} from "../cli-provider-output.js";
import type { CliRunResult, ResolvedCliRunOptions } from "./types.js";

const CODEX_GPT_FAST_ALIASES = new Set(["gpt-fast", "gpt-5.5-fast"]);

function hasConfigOverride(args: string[], key: string): boolean {
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== "-c" && args[index] !== "--config") continue;
    if ((args[index + 1] ?? "").trim().startsWith(`${key}=`)) return true;
  }
  return false;
}

function resolveModelAndArgs(
  requestedModel: string | null,
  providerExtraArgs: string[],
): { model: string | null; extraArgs: string[] } {
  const normalized = requestedModel?.trim().toLowerCase() ?? "";
  if (!normalized) return { model: null, extraArgs: providerExtraArgs };
  if (!CODEX_GPT_FAST_ALIASES.has(normalized)) {
    return { model: requestedModel, extraArgs: providerExtraArgs };
  }
  const extraArgs = [...providerExtraArgs];
  if (!hasConfigOverride(extraArgs, "service_tier")) {
    extraArgs.push("-c", 'service_tier="fast"');
  }
  return { model: normalized === "gpt-5.5-fast" ? "gpt-5.5" : null, extraArgs };
}

async function copyAuthFiles(sourceDir: string | undefined, targetDir: string): Promise<void> {
  const codexHome = sourceDir?.trim() || path.join(homedir(), ".codex");
  await fs
    .copyFile(path.join(codexHome, "auth.json"), path.join(targetDir, "auth.json"))
    .catch(() => {});
}

export async function runCodexCli(options: ResolvedCliRunOptions): Promise<CliRunResult> {
  const { model, extraArgs } = resolveModelAndArgs(
    options.requestedModel,
    options.providerExtraArgs,
  );
  const outputDir = await fs.mkdtemp(path.join(tmpdir(), "summarize-codex-"));
  const outputPath = path.join(outputDir, "last-message.txt");
  const shouldIsolate = !options.allowTools && options.providerConfig?.isolated !== false;
  const isolatedCwd =
    shouldIsolate && !options.cwd
      ? await fs.mkdtemp(path.join(tmpdir(), "summarize-codex-cwd-"))
      : null;
  const isolatedHome = shouldIsolate
    ? await fs.mkdtemp(path.join(tmpdir(), "summarize-codex-home-"))
    : null;
  try {
    if (isolatedHome) await copyAuthFiles(options.env.CODEX_HOME, isolatedHome);
    const args = ["exec", ...extraArgs];
    if (shouldIsolate) {
      args.push("--ephemeral", "--ignore-user-config", "--ignore-rules");
      if (isolatedCwd) args.push("-C", isolatedCwd);
    }
    args.push("--output-last-message", outputPath, "--skip-git-repo-check", "--json");
    if (model) args.push("-m", model);
    let stdout: string;
    try {
      ({ stdout } = await execCliWithInput({
        execFileImpl: options.execFileImpl,
        cmd: options.binary,
        args,
        input: options.prompt,
        timeoutMs: options.timeoutMs,
        env: isolatedHome ? { ...options.env, CODEX_HOME: isolatedHome } : options.env,
        cwd: isolatedCwd ?? options.cwd,
        signal: options.signal,
      }));
    } catch (error) {
      // execCliWithInput attaches the failed run's stdout, where Codex reports the
      // terminal turn failure; the exit error itself only carries argv and stderr.
      const failedStdout = (error as { stdout?: unknown } | null)?.stdout;
      const reason =
        typeof failedStdout === "string" ? extractCodexTurnFailureFromJsonl(failedStdout) : null;
      if (reason) throw new Error(`Codex CLI failed: ${reason}`, { cause: error });
      throw error;
    }
    const { usage, costUsd } = parseCodexUsageFromJsonl(stdout);
    const fileText = await fs
      .readFile(outputPath, "utf8")
      .then((value) => value.trim())
      .catch(() => "");
    if (fileText) return { text: fileText, usage, costUsd };
    const parsed = parseCodexOutputFromJsonl(stdout);
    if (parsed.text) return { text: parsed.text, usage, costUsd };
    if (parsed.sawStructuredEvent) {
      const reason = extractCodexTurnFailureFromJsonl(stdout);
      throw new Error(reason ? `Codex CLI failed: ${reason}` : "CLI returned empty output");
    }
    const stdoutText = stdout.trim();
    if (stdoutText) return { text: stdoutText, usage, costUsd };
    throw new Error("CLI returned empty output");
  } finally {
    await fs.rm(outputDir, { recursive: true, force: true }).catch(() => {});
    if (isolatedCwd) await fs.rm(isolatedCwd, { recursive: true, force: true }).catch(() => {});
    if (isolatedHome) await fs.rm(isolatedHome, { recursive: true, force: true }).catch(() => {});
  }
}
