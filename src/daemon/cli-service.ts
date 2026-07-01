import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveCliEntrypointPathForService } from "./cli-entrypoint.js";
import {
  installLaunchAgent,
  isLaunchAgentLoaded,
  readLaunchAgentProgramArguments,
  restartLaunchAgent,
  resolveDaemonLogPaths,
  uninstallLaunchAgent,
} from "./launchd.js";
import {
  installScheduledTask,
  isScheduledTaskInstalled,
  readScheduledTaskCommand,
  restartScheduledTask,
  uninstallScheduledTask,
} from "./schtasks.js";
import {
  installSystemdService,
  isSystemdServiceEnabled,
  readSystemdServiceExecStart,
  restartSystemdService,
  uninstallSystemdService,
} from "./systemd.js";

type DaemonServiceInstallArgs = {
  env: Record<string, string | undefined>;
  stdout: NodeJS.WritableStream;
  programArguments: string[];
  workingDirectory?: string;
};

export type DaemonService = {
  label: string;
  loadedText: string;
  notLoadedText: string;
  install: (args: DaemonServiceInstallArgs) => Promise<void>;
  uninstall: (args: {
    env: Record<string, string | undefined>;
    stdout: NodeJS.WritableStream;
  }) => Promise<void>;
  restart: (args: {
    env: Record<string, string | undefined>;
    stdout: NodeJS.WritableStream;
  }) => Promise<void>;
  isLoaded: (args: { env: Record<string, string | undefined> }) => Promise<boolean>;
};

export type DaemonProgram = {
  programArguments: string[];
  workingDirectory?: string;
};

export function resolveDaemonService(): DaemonService {
  if (process.platform === "darwin") {
    return {
      label: "LaunchAgent",
      loadedText: "loaded",
      notLoadedText: "not loaded",
      install: async (args) => {
        await installLaunchAgent(args);
      },
      uninstall: uninstallLaunchAgent,
      restart: restartLaunchAgent,
      isLoaded: async () => isLaunchAgentLoaded(),
    };
  }
  if (process.platform === "linux") {
    return {
      label: "systemd",
      loadedText: "enabled",
      notLoadedText: "disabled",
      install: async (args) => {
        await installSystemdService(args);
      },
      uninstall: uninstallSystemdService,
      restart: restartSystemdService,
      isLoaded: async () => isSystemdServiceEnabled(),
    };
  }
  if (process.platform === "win32") {
    return {
      label: "Scheduled Task",
      loadedText: "registered",
      notLoadedText: "missing",
      install: async (args) => {
        await installScheduledTask(args);
      },
      uninstall: uninstallScheduledTask,
      restart: restartScheduledTask,
      isLoaded: async () => isScheduledTaskInstalled(),
    };
  }
  throw new Error(`Daemon service install not supported on ${process.platform}`);
}

function resolveRepoRootForDev(): string {
  const argv1 = process.argv[1];
  if (!argv1) throw new Error("Unable to resolve repo root");
  const normalized = path.resolve(argv1);
  const parts = normalized.split(path.sep);
  const srcIndex = parts.lastIndexOf("src");
  if (srcIndex === -1) throw new Error("Dev mode requires running from repo (src/cli.ts)");
  return parts.slice(0, srcIndex).join(path.sep);
}

async function resolveTypeScriptRegisterPath(repoRoot: string): Promise<string> {
  const candidate = path.join(repoRoot, "scripts", "register-typescript.mjs");
  await fs.access(candidate);
  return candidate;
}

export async function resolveDaemonProgramArguments({
  dev,
  subcommand = "run",
}: {
  dev: boolean;
  subcommand?: "run" | "native-host";
}): Promise<DaemonProgram> {
  const nodePath = process.execPath;
  if (!dev) {
    try {
      const cliEntrypointPath = await resolveCliEntrypointPathForService();
      return {
        programArguments: [nodePath, cliEntrypointPath, "daemon", subcommand],
        workingDirectory: undefined,
      };
    } catch (error) {
      const base = path.basename(nodePath).toLowerCase();
      if (base !== "node" && base !== "node.exe") {
        return {
          programArguments: [nodePath, "daemon", subcommand],
          workingDirectory: undefined,
        };
      }
      throw error;
    }
  }
  const repoRoot = resolveRepoRootForDev();
  const registerPath = await resolveTypeScriptRegisterPath(repoRoot);
  const devCliPath = path.join(repoRoot, "src", "cli.ts");
  await fs.access(devCliPath);
  return {
    programArguments: [nodePath, "--import", registerPath, devCliPath, "daemon", subcommand],
    workingDirectory: repoRoot,
  };
}

export function formatProgramArguments(args: string[]): string {
  return args
    .map((arg) => {
      if (!/[\s"]/g.test(arg)) return arg;
      return `"${arg.replace(/"/g, '\\"')}"`;
    })
    .join(" ");
}

export async function readInstalledDaemonCommand(
  env: Record<string, string | undefined>,
): Promise<DaemonProgram | null> {
  if (process.platform === "darwin") return readLaunchAgentProgramArguments(env);
  if (process.platform === "linux") return readSystemdServiceExecStart(env);
  if (process.platform === "win32") return readScheduledTaskCommand(env);
  return null;
}

export async function startDetachedContainerDaemon({
  env,
  programArguments,
  workingDirectory,
}: {
  env: Record<string, string | undefined>;
  programArguments: string[];
  workingDirectory?: string;
}): Promise<void> {
  const { logDir, stdoutPath, stderrPath } = resolveDaemonLogPaths(env);
  await fs.mkdir(logDir, { recursive: true });

  const stdoutFd = openSync(stdoutPath, "a");
  const stderrFd = openSync(stderrPath, "a");
  try {
    const child = spawn(programArguments[0] ?? process.execPath, programArguments.slice(1), {
      cwd: workingDirectory,
      detached: true,
      env: { ...process.env, ...env },
      stdio: ["ignore", stdoutFd, stderrFd],
      windowsHide: true,
    });
    child.unref();
  } finally {
    closeSync(stdoutFd);
    closeSync(stderrFd);
  }
}
