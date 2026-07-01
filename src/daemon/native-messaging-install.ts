import { execFile as execFileCallback } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { DaemonProgram } from "./cli-service.js";
import {
  CHROME_EXTENSION_ID,
  DAEMON_CONFIG_DIR,
  NATIVE_MESSAGING_HOST_NAME,
  NATIVE_MESSAGING_MANIFEST_FILENAME,
} from "./constants.js";

const execFile = promisify(execFileCallback);

export type NativeMessagingInstallResult = {
  installed: boolean;
  manifestPath: string | null;
  launcherPath: string | null;
  reason?: string;
};

function resolveHome(env: Record<string, string | undefined>): string {
  const home = env.HOME?.trim() || env.USERPROFILE?.trim();
  if (!home) throw new Error("Missing HOME (required for native messaging host)");
  return home;
}

export function resolveChromeNativeMessagingManifestPath(
  env: Record<string, string | undefined>,
  platform: NodeJS.Platform = process.platform,
): string | null {
  const home = resolveHome(env);
  if (platform === "darwin") {
    return path.join(
      home,
      "Library",
      "Application Support",
      "Google",
      "Chrome",
      "NativeMessagingHosts",
      NATIVE_MESSAGING_MANIFEST_FILENAME,
    );
  }
  if (platform === "linux") {
    const configHome = env.XDG_CONFIG_HOME?.trim() || path.join(home, ".config");
    return path.join(
      configHome,
      "google-chrome",
      "NativeMessagingHosts",
      NATIVE_MESSAGING_MANIFEST_FILENAME,
    );
  }
  if (platform === "win32") {
    return path.join(home, DAEMON_CONFIG_DIR, NATIVE_MESSAGING_MANIFEST_FILENAME);
  }
  return null;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export function buildNativeMessagingLauncher(program: DaemonProgram): string {
  const [executable, ...args] = program.programArguments;
  if (!executable) throw new Error("Missing native messaging host executable");
  const command = [executable, ...args].map(shellQuote).join(" ");
  const cwd = program.workingDirectory ? `cd ${shellQuote(program.workingDirectory)}\n` : "";
  return `#!/bin/sh\n${cwd}exec ${command} "$@"\n`;
}

export function buildNativeMessagingManifest({
  launcherPath,
  extensionId = CHROME_EXTENSION_ID,
}: {
  launcherPath: string;
  extensionId?: string;
}) {
  return {
    name: NATIVE_MESSAGING_HOST_NAME,
    description: "Summarize local companion bridge",
    path: launcherPath,
    type: "stdio" as const,
    allowed_origins: [`chrome-extension://${extensionId}/`],
  };
}

export async function installNativeMessagingHost({
  env,
  program,
  extensionId = CHROME_EXTENSION_ID,
  platform = process.platform,
}: {
  env: Record<string, string | undefined>;
  program: DaemonProgram;
  extensionId?: string;
  platform?: NodeJS.Platform;
}): Promise<NativeMessagingInstallResult> {
  const manifestPath = resolveChromeNativeMessagingManifestPath(env, platform);
  if (!manifestPath) {
    return { installed: false, manifestPath: null, launcherPath: null, reason: "unsupported OS" };
  }
  if (platform === "win32") {
    return {
      installed: false,
      manifestPath,
      launcherPath: null,
      reason: "Windows requires a packaged native-host executable",
    };
  }

  const home = resolveHome(env);
  const launcherPath = path.join(home, DAEMON_CONFIG_DIR, "native-host");
  await fs.mkdir(path.dirname(launcherPath), { recursive: true, mode: 0o700 });
  await fs.writeFile(launcherPath, buildNativeMessagingLauncher(program), { mode: 0o700 });
  await fs.chmod(launcherPath, 0o700);
  await fs.mkdir(path.dirname(manifestPath), { recursive: true });
  const manifest = buildNativeMessagingManifest({ launcherPath, extensionId });
  await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return { installed: true, manifestPath, launcherPath };
}

export async function isNativeMessagingHostInstalled({
  env,
  platform = process.platform,
}: {
  env: Record<string, string | undefined>;
  platform?: NodeJS.Platform;
}): Promise<boolean> {
  const manifestPath = resolveChromeNativeMessagingManifestPath(env, platform);
  if (!manifestPath || platform === "win32") return false;
  try {
    const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8")) as {
      name?: unknown;
      allowed_origins?: unknown;
    };
    return (
      manifest.name === NATIVE_MESSAGING_HOST_NAME &&
      Array.isArray(manifest.allowed_origins) &&
      manifest.allowed_origins.includes(`chrome-extension://${CHROME_EXTENSION_ID}/`)
    );
  } catch {
    return false;
  }
}

export async function uninstallNativeMessagingHost({
  env,
  platform = process.platform,
}: {
  env: Record<string, string | undefined>;
  platform?: NodeJS.Platform;
}): Promise<void> {
  const manifestPath = resolveChromeNativeMessagingManifestPath(env, platform);
  if (platform === "win32") {
    await execFile("reg", [
      "delete",
      `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${NATIVE_MESSAGING_HOST_NAME}`,
      "/f",
    ]).catch(() => undefined);
  }
  if (manifestPath) await fs.rm(manifestPath, { force: true });
  const home = resolveHome(env);
  await fs.rm(path.join(home, DAEMON_CONFIG_DIR, "native-host"), { force: true });
}
