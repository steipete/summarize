import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { DAEMON_WINDOWS_TASK_NAME } from "./constants.js";

const execFileAsync = promisify(execFile);

function resolveHomeDir(env: Record<string, string | undefined>): string {
  const home = env.USERPROFILE?.trim() || env.HOME?.trim();
  if (!home) throw new Error("Missing HOME");
  return home;
}

function resolveTaskScriptPath(env: Record<string, string | undefined>): string {
  const home = resolveHomeDir(env);
  return path.join(home, ".summarize", "daemon.cmd");
}

function resolveTaskLauncherPath(env: Record<string, string | undefined>): string {
  const home = resolveHomeDir(env);
  return path.join(home, ".summarize", "daemon-run.vbs");
}

function resolveTaskPidPath(env: Record<string, string | undefined>): string {
  const home = resolveHomeDir(env);
  return path.join(home, ".summarize", "daemon.pid");
}

function quoteCmdArg(value: string): string {
  if (!/[ \t"]/g.test(value)) return value;
  return `"${value.replace(/"/g, '\\"')}"`;
}

function quoteVbsString(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

function parseCommandLine(value: string): string[] {
  const args: string[] = [];
  let current = "";
  let inQuotes = false;
  let escapeNext = false;

  for (const char of value) {
    if (escapeNext) {
      current += char;
      escapeNext = false;
      continue;
    }
    if (char === "\\") {
      escapeNext = true;
      continue;
    }
    if (char === '"') {
      inQuotes = !inQuotes;
      continue;
    }
    if (!inQuotes && /\s/.test(char)) {
      if (current) {
        args.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }
  if (current) args.push(current);
  return args;
}

export async function readScheduledTaskCommand(
  env: Record<string, string | undefined>,
): Promise<{ programArguments: string[]; workingDirectory?: string } | null> {
  const scriptPath = resolveTaskScriptPath(env);
  try {
    const content = await fs.readFile(scriptPath, "utf8");
    let workingDirectory = "";
    let commandLine = "";
    for (const rawLine of content.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line) continue;
      if (line.startsWith("@echo")) continue;
      if (line.toLowerCase().startsWith("rem ")) continue;
      if (line.toLowerCase().startsWith("cd /d ")) {
        workingDirectory = line.slice("cd /d ".length).trim().replace(/^"|"$/g, "");
        continue;
      }
      commandLine = line;
      break;
    }
    if (!commandLine) return null;
    return {
      programArguments: parseCommandLine(commandLine),
      ...(workingDirectory ? { workingDirectory } : {}),
    };
  } catch {
    return null;
  }
}

function buildTaskScript({
  programArguments,
  workingDirectory,
}: {
  programArguments: string[];
  workingDirectory?: string;
}): string {
  const lines: string[] = ["@echo off"];
  if (workingDirectory) {
    lines.push(`cd /d ${quoteCmdArg(workingDirectory)}`);
  }
  const command = programArguments.map(quoteCmdArg).join(" ");
  lines.push(command);
  return `${lines.join("\r\n")}\r\n`;
}

function buildTaskLauncherScript({
  scriptPath,
  pidPath,
}: {
  scriptPath: string;
  pidPath: string;
}): string {
  const escapedScriptPath = quoteVbsString(scriptPath);
  const escapedPidPath = quoteVbsString(pidPath);
  return [
    'Set fso = CreateObject("Scripting.FileSystemObject")',
    'Set processStartup = GetObject("winmgmts:root\\cimv2:Win32_ProcessStartup").SpawnInstance_',
    "processStartup.ShowWindow = 0",
    `scriptPath = ${escapedScriptPath}`,
    `pidPath = ${escapedPidPath}`,
    'command = "cmd.exe /d /c " & Chr(34) & scriptPath & Chr(34)',
    "processId = 0",
    'result = GetObject("winmgmts:root\\cimv2:Win32_Process").Create(command, Null, processStartup, processId)',
    "If result <> 0 Then",
    "  WScript.Quit result",
    "End If",
    "Set pidFile = fso.OpenTextFile(pidPath, 2, True)",
    "pidFile.Write CStr(processId)",
    "pidFile.Close",
    "Do While ProcessExists(processId)",
    "  WScript.Sleep 1000",
    "Loop",
    "If fso.FileExists(pidPath) Then",
    "  Set currentPidFile = fso.OpenTextFile(pidPath, 1, False)",
    "  currentPid = Trim(currentPidFile.ReadAll)",
    "  currentPidFile.Close",
    "  If currentPid = CStr(processId) Then",
    "    fso.DeleteFile pidPath, True",
    "  End If",
    "End If",
    "",
    "Function ProcessExists(pid)",
    '  Set processes = GetObject("winmgmts:root\\cimv2").ExecQuery("SELECT ProcessId FROM Win32_Process WHERE ProcessId = " & pid)',
    "  ProcessExists = (processes.Count > 0)",
    "End Function",
    "",
  ].join("\r\n");
}

async function execWindowsCommand(
  file: string,
  args: string[],
): Promise<{ stdout: string; stderr: string; code: number }> {
  try {
    const { stdout, stderr } = await execFileAsync(file, args, {
      encoding: "utf8",
      windowsHide: true,
    });
    return { stdout: String(stdout ?? ""), stderr: String(stderr ?? ""), code: 0 };
  } catch (error) {
    const e = error as { stdout?: unknown; stderr?: unknown; code?: unknown; message?: unknown };
    return {
      stdout: typeof e.stdout === "string" ? e.stdout : "",
      stderr:
        typeof e.stderr === "string" ? e.stderr : typeof e.message === "string" ? e.message : "",
      code: typeof e.code === "number" ? e.code : 1,
    };
  }
}

async function execSchtasks(
  args: string[],
): Promise<{ stdout: string; stderr: string; code: number }> {
  return execWindowsCommand("schtasks", args);
}

async function execTaskkill(
  args: string[],
): Promise<{ stdout: string; stderr: string; code: number }> {
  return execWindowsCommand("taskkill", args);
}

async function assertSchtasksAvailable() {
  const res = await execSchtasks(["/Query"]);
  if (res.code === 0) return;
  const detail = res.stderr || res.stdout;
  throw new Error(`schtasks unavailable: ${detail || "unknown error"}`.trim());
}

function isMissingProcessError(detail: string): boolean {
  return /not found|not running|no running instance|does not exist/i.test(detail);
}

async function stopTrackedTaskProcessTree(env: Record<string, string | undefined>): Promise<void> {
  const pidPath = resolveTaskPidPath(env);
  let pid = "";
  try {
    pid = (await fs.readFile(pidPath, "utf8")).trim();
  } catch {
    return;
  }

  const pidNumber = Number(pid);
  if (!Number.isInteger(pidNumber) || pidNumber <= 0) {
    await fs.unlink(pidPath).catch(() => {});
    return;
  }

  const res = await execTaskkill(["/PID", `${pidNumber}`, "/T", "/F"]);
  const detail = (res.stderr || res.stdout).trim();
  if (res.code !== 0 && !isMissingProcessError(detail)) {
    throw new Error(`taskkill failed: ${detail || "unknown error"}`.trim());
  }

  await fs.unlink(pidPath).catch(() => {});
}

export async function installScheduledTask({
  env,
  stdout,
  programArguments,
  workingDirectory,
}: {
  env: Record<string, string | undefined>;
  stdout: NodeJS.WritableStream;
  programArguments: string[];
  workingDirectory?: string;
}): Promise<{ scriptPath: string }> {
  await assertSchtasksAvailable();
  const scriptPath = resolveTaskScriptPath(env);
  const launcherPath = resolveTaskLauncherPath(env);
  const pidPath = resolveTaskPidPath(env);
  await fs.mkdir(path.dirname(scriptPath), { recursive: true });
  const script = buildTaskScript({ programArguments, workingDirectory });
  await fs.writeFile(scriptPath, script, "utf8");
  await fs.unlink(pidPath).catch(() => {});
  const launcher = buildTaskLauncherScript({ scriptPath, pidPath });
  await fs.writeFile(launcherPath, launcher, "utf8");

  const quotedLauncher = quoteCmdArg(launcherPath);
  const create = await execSchtasks([
    "/Create",
    "/F",
    "/SC",
    "ONLOGON",
    "/RL",
    "LIMITED",
    "/TN",
    DAEMON_WINDOWS_TASK_NAME,
    "/TR",
    quotedLauncher,
  ]);
  if (create.code !== 0) {
    const detail = (create.stderr || create.stdout).trim();
    const hint = /access is denied/i.test(detail)
      ? " (run `summarize daemon install` from an elevated PowerShell/cmd — schtasks /SC ONLOGON requires Administrator)"
      : "";
    throw new Error(`schtasks create failed: ${detail}${hint}`);
  }

  await execSchtasks(["/Run", "/TN", DAEMON_WINDOWS_TASK_NAME]);
  stdout.write(`Installed Scheduled Task: ${DAEMON_WINDOWS_TASK_NAME}\n`);
  stdout.write(`Task script: ${scriptPath}\n`);
  return { scriptPath };
}

export async function uninstallScheduledTask({
  env,
  stdout,
}: {
  env: Record<string, string | undefined>;
  stdout: NodeJS.WritableStream;
}): Promise<void> {
  await assertSchtasksAvailable();
  await stopTrackedTaskProcessTree(env);
  await execSchtasks(["/End", "/TN", DAEMON_WINDOWS_TASK_NAME]);
  await execSchtasks(["/Delete", "/F", "/TN", DAEMON_WINDOWS_TASK_NAME]);

  const scriptPath = resolveTaskScriptPath(env);
  const launcherPath = resolveTaskLauncherPath(env);
  const pidPath = resolveTaskPidPath(env);
  try {
    await fs.unlink(scriptPath);
    stdout.write(`Removed task script: ${scriptPath}\n`);
  } catch {
    stdout.write(`Task script not found at ${scriptPath}\n`);
  }
  try {
    await fs.unlink(launcherPath);
    stdout.write(`Removed task launcher: ${launcherPath}\n`);
  } catch {
    stdout.write(`Task launcher not found at ${launcherPath}\n`);
  }
  await fs.unlink(pidPath).catch(() => {});
}

export async function restartScheduledTask({
  env,
  stdout,
}: {
  env: Record<string, string | undefined>;
  stdout: NodeJS.WritableStream;
}): Promise<void> {
  await assertSchtasksAvailable();
  await stopTrackedTaskProcessTree(env);
  await execSchtasks(["/End", "/TN", DAEMON_WINDOWS_TASK_NAME]);
  const res = await execSchtasks(["/Run", "/TN", DAEMON_WINDOWS_TASK_NAME]);
  if (res.code !== 0) {
    throw new Error(`schtasks run failed: ${res.stderr || res.stdout}`.trim());
  }
  stdout.write(`Restarted Scheduled Task: ${DAEMON_WINDOWS_TASK_NAME}\n`);
}

export async function isScheduledTaskInstalled(): Promise<boolean> {
  await assertSchtasksAvailable();
  const res = await execSchtasks(["/Query", "/TN", DAEMON_WINDOWS_TASK_NAME]);
  return res.code === 0;
}
