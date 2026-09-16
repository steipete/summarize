import type { Command } from "commander";
import { readCliOptionValue } from "../cli-args.js";
import { handleDaemonRequest } from "../daemon/cli.js";
import { CliError } from "../locale.js";
import { resolveCliLocaleFromArgs } from "../locale.js";
import { refreshFree } from "../refresh-free.js";
import {
  applyHelpStyle,
  attachRichHelp,
  buildDaemonHelp,
  buildProgram,
  buildRefreshFreeHelp,
  buildSlidesProgram,
  buildStatusHelp,
  buildTranscriberHelp,
} from "./help.js";

type HelpContext = {
  normalizedArgv: string[];
  envForRun: Record<string, string | undefined>;
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
};

export function handleHelpRequest({
  normalizedArgv,
  envForRun,
  stdout,
  stderr,
}: HelpContext): boolean {
  if (normalizedArgv[0]?.toLowerCase() !== "help") return false;
  const locale = resolveCliLocaleFromArgs(normalizedArgv, envForRun);
  const writeHelp = (text: string) => stdout.write(`${text}\n`);
  const topic = normalizedArgv[1]?.toLowerCase();
  if (topic === "refresh-free") {
    writeHelp(buildRefreshFreeHelp(locale));
    return true;
  }
  if (topic === "daemon") {
    writeHelp(buildDaemonHelp(locale));
    return true;
  }
  if (topic === "status") {
    writeHelp(buildStatusHelp(locale));
    return true;
  }
  if (topic === "slides") {
    const slidesProgram: Command = buildSlidesProgram(locale);
    slidesProgram.configureOutput({
      writeOut(str) {
        stdout.write(str);
      },
      writeErr(str) {
        stderr.write(str);
      },
    });
    applyHelpStyle(slidesProgram, envForRun, stdout);
    slidesProgram.outputHelp();
    return true;
  }
  if (topic === "transcriber") {
    writeHelp(buildTranscriberHelp(locale));
    return true;
  }

  const program: Command = buildProgram(locale);
  program.configureOutput({
    writeOut(str) {
      stdout.write(str);
    },
    writeErr(str) {
      stderr.write(str);
    },
  });
  attachRichHelp(program, envForRun, stdout);
  program.outputHelp();
  return true;
}

type RefreshContext = {
  normalizedArgv: string[];
  envForRun: Record<string, string | undefined>;
  fetchImpl: typeof fetch;
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
};

export async function handleRefreshFreeRequest({
  normalizedArgv,
  envForRun,
  fetchImpl,
  stdout,
  stderr,
}: RefreshContext): Promise<boolean> {
  if (normalizedArgv[0]?.toLowerCase() !== "refresh-free") return false;

  const verbose = normalizedArgv.includes("--verbose") || normalizedArgv.includes("--debug");
  const setDefault = normalizedArgv.includes("--set-default");
  const help =
    normalizedArgv.includes("--help") ||
    normalizedArgv.includes("-h") ||
    normalizedArgv.includes("help");

  const runsRaw = readCliOptionValue(normalizedArgv, "--runs");
  const smartRaw = readCliOptionValue(normalizedArgv, "--smart");
  const minParamsRaw = readCliOptionValue(normalizedArgv, "--min-params");
  const maxAgeDaysRaw = readCliOptionValue(normalizedArgv, "--max-age-days");
  const runs = runsRaw ? Number(runsRaw) : 2;
  const smart = smartRaw ? Number(smartRaw) : 3;
  const minParams = (() => {
    if (!minParamsRaw) return 27;
    const raw = minParamsRaw.trim().toLowerCase();
    const normalized = raw.endsWith("b") ? raw.slice(0, -1).trim() : raw;
    return Number(normalized);
  })();
  const maxAgeDays = (() => {
    if (!maxAgeDaysRaw) return 180;
    return Number(maxAgeDaysRaw.trim());
  })();

  if (help) {
    stdout.write(`${buildRefreshFreeHelp(resolveCliLocaleFromArgs(normalizedArgv, envForRun))}\n`);
    return true;
  }

  if (!Number.isFinite(runs) || runs < 0) throw new CliError("error.invalidRuns");
  if (!Number.isFinite(smart) || smart < 0) throw new CliError("error.invalidSmart");
  if (!Number.isFinite(minParams) || minParams < 0) throw new CliError("error.invalidMinParams");
  if (!Number.isFinite(maxAgeDays) || maxAgeDays < 0) throw new CliError("error.invalidMaxAge");

  await refreshFree({
    env: envForRun,
    fetchImpl,
    stdout,
    stderr,
    verbose,
    options: {
      runs,
      smart,
      minParamB: minParams,
      maxAgeDays,
      setDefault,
      maxCandidates: 10,
      concurrency: 4,
      timeoutMs: 10_000,
    },
  });
  return true;
}

export async function handleDaemonCliRequest(ctx: RefreshContext): Promise<boolean> {
  return handleDaemonRequest({
    normalizedArgv: ctx.normalizedArgv,
    envForRun: ctx.envForRun,
    fetchImpl: ctx.fetchImpl,
    stdout: ctx.stdout,
    stderr: ctx.stderr,
  });
}
