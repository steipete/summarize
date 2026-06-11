import { accessSync, constants, existsSync } from "node:fs";
import { delimiter, dirname, resolve } from "node:path";
import { spawnTracked, type SpawnTrackedOptions } from "../processes.js";

export type FfmpegTool = "ffmpeg" | "ffprobe";

export type FfmpegCommand = {
  command: string;
  argsPrefix: string[];
  source: "wasm";
};

function isBundledRuntimeDisabled(): boolean {
  const value = process.env.SUMMARIZE_DISABLE_FFMPEG_WASM?.trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes";
}

function resolveNodeCommand(): string | null {
  const explicit = process.env.SUMMARIZE_NODE_PATH?.trim();
  const candidates = explicit
    ? [explicit]
    : (process.env.PATH ?? "")
        .split(delimiter)
        .filter(Boolean)
        .map((dir) => resolve(dir, process.platform === "win32" ? "node.exe" : "node"));
  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Try the next PATH entry.
    }
  }
  return null;
}

function isAssetsDir(candidate: string): boolean {
  return (
    existsSync(resolve(candidate, "ffmpeg.js")) &&
    existsSync(resolve(candidate, "ffmpeg_g")) &&
    existsSync(resolve(candidate, "ffmpeg_g.wasm")) &&
    existsSync(resolve(candidate, "ffprobe.js")) &&
    existsSync(resolve(candidate, "ffprobe_g")) &&
    existsSync(resolve(candidate, "ffprobe_g.wasm"))
  );
}

function resolveExternalRuntime(tool: FfmpegTool): FfmpegCommand | null {
  for (const executable of [process.argv[0], process.execPath]) {
    if (!executable) continue;
    const installDir = dirname(executable);
    const runner = resolve(installDir, "ffmpeg-wasm", "run-generated.js");
    const assetsDir = resolve(installDir, "ffmpeg-wasm", "node");
    if (!existsSync(runner) || !isAssetsDir(assetsDir)) continue;
    const nodeCommand = resolveNodeCommand();
    if (!nodeCommand) return null;
    return {
      command: nodeCommand,
      argsPrefix: [runner, tool, assetsDir, ...(tool === "ffmpeg" ? ["-nostdin"] : [])],
      source: "wasm",
    };
  }
  return null;
}

function resolveNodeRuntime(tool: FfmpegTool): FfmpegCommand | null {
  const assetsDir = [
    resolve(import.meta.dirname, "..", "..", "ffmpeg-wasm", "node"),
    resolve(import.meta.dirname, "..", "..", "vendor", "ffmpeg-wasm", "node"),
  ].find(isAssetsDir);
  const runner = [
    resolve(import.meta.dirname, "run-generated.js"),
    resolve(import.meta.dirname, "run-generated.ts"),
  ].find((candidate) => existsSync(candidate));
  if (!assetsDir || !runner) return null;
  return {
    command: process.execPath,
    argsPrefix: [runner, tool, assetsDir, ...(tool === "ffmpeg" ? ["-nostdin"] : [])],
    source: "wasm",
  };
}

export function hasBundledFfmpegWasm(): boolean {
  return resolveBundledFfmpegCommand("ffmpeg") !== null;
}

export function resolveBundledFfmpegCommand(tool: FfmpegTool): FfmpegCommand | null {
  if (isBundledRuntimeDisabled()) return null;
  const external = resolveExternalRuntime(tool);
  if (external || "bun" in process.versions) return external;
  return resolveNodeRuntime(tool);
}

export function spawnBundledFfmpeg(
  tool: FfmpegTool,
  args: string[],
  options: SpawnTrackedOptions = {},
) {
  const resolved = resolveBundledFfmpegCommand(tool);
  if (!resolved) return null;
  return spawnTracked(resolved.command, [...resolved.argsPrefix, ...args], options);
}
