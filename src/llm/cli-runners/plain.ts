import { Buffer } from "node:buffer";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseAgyModel } from "../../agy-model.js";
import { execCliWithInput } from "../cli-exec.js";
import type { CliRunResult, ResolvedCliRunOptions } from "./types.js";

function hasAnyFlag(args: string[], flags: string[]): boolean {
  return args.some((arg) => flags.some((flag) => arg === flag || arg.startsWith(`${flag}=`)));
}

const AGY_MAX_PRINT_ARG_BYTES = 120 * 1024;
const AGY_WINDOWS_MAX_COMMAND_CHARS = 30_000;

export type AgyPrintArgLimit = { limit: number; type: "bytes" | "chars" };

export function resolveAgyMaxPrintArgLimit(
  platform: NodeJS.Platform = typeof process !== "undefined" ? process.platform : "linux",
): AgyPrintArgLimit {
  return platform === "win32"
    ? { limit: AGY_WINDOWS_MAX_COMMAND_CHARS, type: "chars" }
    : { limit: AGY_MAX_PRINT_ARG_BYTES, type: "bytes" };
}

function estimateWindowsCommandArgChars(arg: string): number {
  if (arg.length === 0) return 2;
  if (!/[\s"]/u.test(arg)) return arg.length;
  let length = 2;
  let backslashes = 0;
  for (let index = 0; index < arg.length; index += 1) {
    const char = arg[index];
    if (char === "\\") {
      backslashes += 1;
      length += 1;
      continue;
    }
    if (char === '"') length += backslashes + 1;
    backslashes = 0;
    length += 1;
  }
  return length + backslashes;
}

export function estimateWindowsCommandChars(args: string[]): number {
  return args.reduce((total, arg, index) => {
    return total + (index === 0 ? 0 : 1) + estimateWindowsCommandArgChars(arg);
  }, 0);
}

export async function runCopilotCli(options: ResolvedCliRunOptions): Promise<CliRunResult> {
  const args = [...options.providerExtraArgs, "-p", options.prompt];
  if (options.allowTools) args.push("--allow-all-tools");
  if (options.requestedModel) args.push("--model", options.requestedModel);
  const { stdout } = await execCliWithInput({
    execFileImpl: options.execFileImpl,
    cmd: options.binary,
    args,
    input: "",
    timeoutMs: options.timeoutMs,
    env: options.env,
    cwd: options.cwd,
    signal: options.signal,
  });
  const text = stdout.trim();
  if (!text) throw new Error("CLI returned empty output");
  return { text, usage: null, costUsd: null };
}

export const AGY_NO_TOOLS_GUIDANCE =
  "\n\nIMPORTANT: Do not use tools or create files. Do not include local file links or work-log narration. Return only the final text response.";

function assembleAgyPrompt(prompt: string, allowTools: boolean, offloaded = false): string {
  if (allowTools) return prompt;
  return (
    prompt +
    (offloaded
      ? "\n\nIMPORTANT: Only read the supplied document. Do not create or edit files. Do not include local file links or work-log narration. Return only the final text response."
      : AGY_NO_TOOLS_GUIDANCE)
  );
}

export async function runAgyCli(options: ResolvedCliRunOptions): Promise<CliRunResult> {
  const platform = typeof process !== "undefined" ? process.platform : "linux";
  const isWindows = platform === "win32";
  let temporaryDirectory = !options.allowTools
    ? await fs.mkdtemp(path.join(tmpdir(), "summarize-agy-"))
    : null;
  try {
    const args = [...options.providerExtraArgs];
    if (!options.allowTools && !hasAnyFlag(args, ["--sandbox"])) args.push("--sandbox");
    if (options.requestedModel && !hasAnyFlag(args, ["--model", "-model"])) {
      args.push("--model", parseAgyModel(options.requestedModel));
    }
    if (options.prompt.includes("\0")) {
      throw new Error(
        "Antigravity CLI cannot receive prompts containing NUL characters over argv. " +
          "Use a different CLI provider for this input or remove the NUL characters.",
      );
    }
    const { limit, type } = resolveAgyMaxPrintArgLimit(platform);
    if (
      Number.isFinite(options.timeoutMs) &&
      options.timeoutMs > 0 &&
      !hasAnyFlag(args, ["--print-timeout", "-print-timeout"])
    ) {
      args.push("--print-timeout", `${Math.max(1, Math.ceil(options.timeoutMs / 1000))}s`);
    }

    const commandSize = (prompt: string): number => {
      const command = [options.binary, ...args, "--print", prompt];
      return isWindows
        ? estimateWindowsCommandChars(command)
        : Buffer.byteLength(command.join(" "), "utf8");
    };
    let printPrompt = assembleAgyPrompt(options.prompt, options.allowTools);

    if (commandSize(printPrompt) > limit) {
      temporaryDirectory ??= await fs.mkdtemp(path.join(tmpdir(), "summarize-agy-prompt-"));
      const documentPath = path.join(temporaryDirectory, "document.txt");
      // Instructions may contain tag examples; the final context/content blocks are escaped.
      const taggedPrompt =
        /^(<instructions>[\s\S]*<\/instructions>\s*<context>[^<]*<\/context>\s*)(<content>[^<]*<\/content>)([\s\S]*)$/i.exec(
          options.prompt,
        );
      const payloadToSave = taggedPrompt?.[2] ?? options.prompt;
      const promptInstructions = taggedPrompt
        ? [taggedPrompt[1].trim(), taggedPrompt[3].trim()].filter(Boolean).join("\n\n")
        : "";

      await fs.writeFile(documentPath, payloadToSave, { mode: 0o600, encoding: "utf-8" });
      const documentUrl = pathToFileURL(documentPath).href;

      const fileInstruction = promptInstructions
        ? `${promptInstructions}\n\nUse the content in ${documentUrl}`
        : `Fulfill the request and process the content in ${documentUrl}`;
      printPrompt = assembleAgyPrompt(fileInstruction, options.allowTools, true);
    }

    const finalCommandSize = commandSize(printPrompt);

    if (finalCommandSize > limit) {
      throw new Error(
        `Antigravity CLI requires --print <prompt> and cannot safely receive large command arguments over argv (${finalCommandSize} ${type}). ` +
          "Use a different CLI provider for this input, reduce extra args or extracted content, or update agy to support stdin/file input.",
      );
    }

    args.push("--print", printPrompt);

    const redactedCommand = [
      options.binary,
      ...args.map((arg, index) => (args[index - 1] === "--print" ? "[prompt redacted]" : arg)),
    ].join(" ");
    const { stdout } = await execCliWithInput({
      execFileImpl: options.execFileImpl,
      cmd: options.binary,
      args,
      input: "",
      timeoutMs: options.timeoutMs,
      env: options.env,
      cwd: options.allowTools ? options.cwd : (temporaryDirectory ?? options.cwd),
      signal: options.signal,
      redactedCommand,
      failureHint: hasAnyFlag(args, ["--model", "-model"])
        ? "Check the selected Antigravity model with `agy models` and use agy 1.1.5 or newer. Unknown models fail in print mode; remove cli.agy.model and model extraArgs to use the active session model."
        : undefined,
    });
    const text = stdout.trim();
    if (!text) throw new Error("CLI returned empty output");
    return { text, usage: null, costUsd: null };
  } finally {
    if (temporaryDirectory) {
      await fs.rm(temporaryDirectory, { recursive: true, force: true }).catch(() => {});
    }
  }
}
