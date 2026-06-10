import fs from "node:fs/promises";
import { clearCacheFiles, DEFAULT_CACHE_MAX_MB, resolveCachePath } from "../cache.js";
import { loadSummarizeConfig, mergeConfigEnv } from "../config.js";
import { formatVersionLine } from "../version.js";

export function prepareRunEnvironment(
  argv: string[],
  inputEnv: Record<string, string | undefined>,
) {
  const normalizedArgv = normalizeDiarizeArgv(argv.filter((arg) => arg !== "--"));
  const noColorFlag = normalizedArgv.includes("--no-color");
  let envForRun: Record<string, string | undefined> = noColorFlag
    ? { ...inputEnv, NO_COLOR: "1", FORCE_COLOR: "0" }
    : { ...inputEnv };
  const { config: bootstrapConfig } = loadSummarizeConfig({ env: envForRun });
  envForRun = mergeConfigEnv({ env: envForRun, config: bootstrapConfig });
  return { normalizedArgv, envForRun };
}

export function normalizeDiarizeArgv(argv: string[]): string[] {
  return argv.map((arg, index) => {
    if (arg !== "--diarize") return arg;
    const next = argv[index + 1];
    return next && /^[a-z][a-z\d+.-]*:\/\//i.test(next) ? "--diarize=auto" : arg;
  });
}

export function handleVersionFlag({
  versionRequested,
  stdout,
  importMetaUrl,
}: {
  versionRequested: boolean;
  stdout: NodeJS.WritableStream;
  importMetaUrl?: string;
}) {
  if (!versionRequested) return false;
  stdout.write(`${formatVersionLine(importMetaUrl)}\n`);
  return true;
}

export function applyWidthOverride({
  width,
  env,
}: {
  width: unknown;
  env: Record<string, string | undefined>;
}) {
  const widthArg = typeof width === "string" ? Number(width) : undefined;
  if (widthArg === undefined) return;
  if (!Number.isFinite(widthArg) || widthArg < 20) {
    throw new Error("--width must be a number >= 20.");
  }
  env.COLUMNS = String(Math.floor(widthArg));
}

export async function resolvePromptOverride({
  prompt,
  promptFile,
}: {
  prompt: unknown;
  promptFile: unknown;
}): Promise<string | null> {
  const promptArg = typeof prompt === "string" ? prompt : null;
  const promptFileArg = typeof promptFile === "string" ? promptFile : null;
  if (promptArg && promptFileArg) {
    throw new Error("Use either --prompt or --prompt-file (not both).");
  }

  if (promptFileArg) {
    let text: string;
    try {
      text = await fs.readFile(promptFileArg, "utf8");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to read --prompt-file ${promptFileArg}: ${message}`);
    }
    const trimmed = text.trim();
    if (!trimmed) {
      throw new Error(`Prompt file ${promptFileArg} is empty.`);
    }
    return trimmed;
  }

  if (!promptArg) return null;
  const trimmed = promptArg.trim();
  if (!trimmed) {
    throw new Error("Prompt must not be empty.");
  }
  return trimmed;
}

export async function handleCacheUtilityFlags({
  normalizedArgv,
  envForRun,
  stdout,
}: {
  normalizedArgv: string[];
  envForRun: Record<string, string | undefined>;
  stdout: NodeJS.WritableStream;
}) {
  const clearCacheFlag = normalizedArgv.includes("--clear-cache");
  if (clearCacheFlag) {
    const extraArgs = normalizedArgv.filter((arg) => arg !== "--clear-cache");
    if (extraArgs.length > 0) {
      throw new Error("--clear-cache must be used alone.");
    }
    const { config } = loadSummarizeConfig({ env: envForRun });
    const cachePath = resolveCachePath({
      env: envForRun,
      cachePath: config?.cache?.path ?? null,
    });
    if (!cachePath) {
      throw new Error("Unable to resolve cache path (missing HOME).");
    }
    clearCacheFiles(cachePath);
    stdout.write("Cache cleared.\n");
    return true;
  }

  const cacheStatsFlag = normalizedArgv.includes("--cache-stats");
  if (!cacheStatsFlag) return false;

  const extraArgs = normalizedArgv.filter((arg) => arg !== "--cache-stats");
  if (extraArgs.length > 0) {
    throw new Error("--cache-stats must be used alone.");
  }
  const { config } = loadSummarizeConfig({ env: envForRun });
  const cachePath = resolveCachePath({
    env: envForRun,
    cachePath: config?.cache?.path ?? null,
  });
  if (!cachePath) {
    throw new Error("Unable to resolve cache path (missing HOME).");
  }
  const cacheMaxMb =
    typeof config?.cache?.maxMb === "number" ? config.cache.maxMb : DEFAULT_CACHE_MAX_MB;
  const cacheMaxBytes = Math.max(0, cacheMaxMb) * 1024 * 1024;
  const { readCacheStats } = await import("../cache.js");
  const { formatBytes } = await import("../tty/format.js");
  const stats = await readCacheStats(cachePath);
  stdout.write(`Cache path: ${cachePath}\n`);
  if (!stats) {
    stdout.write("Cache is empty.\n");
    return true;
  }
  const sizeLabel = formatBytes(stats.sizeBytes);
  const maxLabel = cacheMaxBytes > 0 ? formatBytes(cacheMaxBytes) : "disabled";
  stdout.write(`Size: ${sizeLabel} (max ${maxLabel})\n`);
  stdout.write(
    `Entries: total=${stats.totalEntries} extract=${stats.counts.extract} summary=${stats.counts.summary} transcript=${stats.counts.transcript}\n`,
  );
  return true;
}
