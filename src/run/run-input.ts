import type { Command } from "commander";
import type { InputTarget } from "../content/asset.js";
import { resolveInputTarget } from "../content/asset.js";
import { buildConciseHelp } from "./help.js";

export type InputResolution = {
  inputTarget: InputTarget;
  url: string | null;
  cliProviderArgRaw: string | null;
};

export function resolveRunInput({
  program,
  cliFlagPresent,
  cliProviderArgRaw,
  stdout,
}: {
  program: Command;
  cliFlagPresent: boolean;
  cliProviderArgRaw: string | null;
  stdout: NodeJS.WritableStream;
}): InputResolution {
  let rawInput = program.args[0];
  let resolvedCliProviderArgRaw = cliProviderArgRaw;
  if (!rawInput && cliFlagPresent && resolvedCliProviderArgRaw) {
    try {
      resolveInputTarget(resolvedCliProviderArgRaw);
      rawInput = resolvedCliProviderArgRaw;
      resolvedCliProviderArgRaw = null;
    } catch {
      // keep rawInput as-is
    }
  }
  if (!rawInput) {
    const help = buildConciseHelp();
    stdout.write(`${help}\n`);
    throw Object.assign(new Error(help), { exitCode: 1, silent: true });
  }

  const inputTarget = resolveInputTarget(rawInput);
  const url = inputTarget.kind === "url" ? inputTarget.url : null;

  return { inputTarget, url, cliProviderArgRaw: resolvedCliProviderArgRaw };
}
