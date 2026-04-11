import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { readDaemonConfig } from "./config.js";
import { DAEMON_HOST, DAEMON_WINDOWS_TASK_NAME } from "./constants.js";

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
  return path.join(home, ".summarize", "daemon-launch.vbs");
}

function resolveTaskDefinitionPath(env: Record<string, string | undefined>): string {
  const home = resolveHomeDir(env);
  return path.join(home, ".summarize", "daemon-task.xml");
}

function resolveCurrentUserPrincipal(env: Record<string, string | undefined>): string {
  const username = env.USERNAME?.trim();
  if (!username) throw new Error("Missing USERNAME");
  const domain = env.USERDOMAIN?.trim() || env.COMPUTERNAME?.trim();
  return domain ? `${domain}\\${username}` : username;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function buildScheduledTaskXml({
  launcherPath,
  userPrincipal,
}: {
  launcherPath: string;
  userPrincipal: string;
}): string {
  const userId = escapeXml(userPrincipal);
  const args = escapeXml(`//B //Nologo "${launcherPath}"`);
  // schtasks /Create /SC ONLOGON defaults DisallowStartIfOnBatteries and
  // StopIfGoingOnBatteries to true. On a laptop unplugged at install time the
  // task silently no-ops every /Run with Last Result 0, which is what made the
  // daemon look like it was failing to start. Register via /XML so we can flip
  // those flags off and own every other relevant setting too.
  return [
    '<?xml version="1.0" encoding="UTF-16"?>',
    '<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">',
    "  <RegistrationInfo>",
    "    <Author>summarize</Author>",
    "  </RegistrationInfo>",
    "  <Triggers>",
    "    <LogonTrigger>",
    "      <Enabled>true</Enabled>",
    `      <UserId>${userId}</UserId>`,
    "    </LogonTrigger>",
    "  </Triggers>",
    "  <Principals>",
    '    <Principal id="Author">',
    `      <UserId>${userId}</UserId>`,
    "      <LogonType>InteractiveToken</LogonType>",
    "      <RunLevel>LeastPrivilege</RunLevel>",
    "    </Principal>",
    "  </Principals>",
    "  <Settings>",
    "    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>",
    "    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>",
    "    <AllowHardTerminate>true</AllowHardTerminate>",
    "    <StartWhenAvailable>true</StartWhenAvailable>",
    "    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>",
    "    <IdleSettings>",
    "      <StopOnIdleEnd>false</StopOnIdleEnd>",
    "      <RestartOnIdle>false</RestartOnIdle>",
    "    </IdleSettings>",
    "    <AllowStartOnDemand>true</AllowStartOnDemand>",
    "    <Enabled>true</Enabled>",
    "    <Hidden>true</Hidden>",
    "    <RunOnlyIfIdle>false</RunOnlyIfIdle>",
    "    <WakeToRun>false</WakeToRun>",
    "    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>",
    "    <Priority>7</Priority>",
    "  </Settings>",
    '  <Actions Context="Author">',
    "    <Exec>",
    "      <Command>wscript.exe</Command>",
    `      <Arguments>${args}</Arguments>`,
    "    </Exec>",
    "  </Actions>",
    "</Task>",
    "",
  ].join("\r\n");
}

function resolveLegacyLauncherPath(env: Record<string, string | undefined>): string {
  // The pre-XML installer wrote a different VBS at this path. Removed in
  // favor of daemon-launch.vbs; we still clean it up on upgrade.
  const home = resolveHomeDir(env);
  return path.join(home, ".summarize", "daemon-run.vbs");
}

function resolveLegacyPidPath(env: Record<string, string | undefined>): string {
  const home = resolveHomeDir(env);
  return path.join(home, ".summarize", "daemon.pid");
}

function quoteCmdArg(value: string): string {
  if (!/[ \t"]/g.test(value)) return value;
  return `"${value.replace(/"/g, '\\"')}"`;
}

function parseCommandLine(value: string): string[] {
  const args: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < value.length; i += 1) {
    const char = value[i];
    if (char === '"') {
      if (inQuotes && value[i + 1] === '"') {
        current += '"';
        i += 1;
        continue;
      }
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

function quoteVbsString(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

function buildLauncherVbs({
  programArguments,
  workingDirectory,
}: {
  programArguments: string[];
  workingDirectory?: string;
}): string {
  // Run the daemon via wscript + WshShell.Run with windowStyle=0 so node is
  // started with CREATE_NO_WINDOW. wscript itself is a Windows-subsystem app,
  // so it never allocates a console. Net effect: zero windows, zero conhost,
  // even on a logged-in interactive session.
  const command = programArguments.map(quoteCmdArg).join(" ");
  const lines = ['Set sh = CreateObject("WScript.Shell")'];
  if (workingDirectory) {
    lines.push(`sh.CurrentDirectory = ${quoteVbsString(workingDirectory)}`);
  }
  lines.push(`sh.Run ${quoteVbsString(command)}, 0, False`);
  lines.push("");
  return lines.join("\r\n");
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

function isMissingProcessError(detail: string): boolean {
  return /not found|not running|no running instance|does not exist/i.test(detail);
}

async function fetchDaemonPid(env: Record<string, string | undefined>): Promise<number | null> {
  const cfg = await readDaemonConfig({ env });
  if (!cfg) return null;
  const url = `http://${DAEMON_HOST}:${cfg.port}/health`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1000);
  try {
    const res = await fetch(url, { method: "GET", signal: controller.signal });
    if (!res.ok) return null;
    const body = (await res.json()) as { pid?: unknown };
    const pid = typeof body.pid === "number" ? body.pid : null;
    return pid && Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// schtasks /End only kills the task action process (cmd.exe). The daemon node
// process detaches from cmd at startup, so /End orphans it and a subsequent
// /Run hits "port already in use" and exits 1 — silent restart no-op. Ask the
// daemon for its own pid via /health and taskkill the tree before /End.
async function killRunningDaemon(env: Record<string, string | undefined>): Promise<void> {
  const pid = await fetchDaemonPid(env);
  if (pid === null) return;
  const res = await execTaskkill(["/PID", `${pid}`, "/T", "/F"]);
  const detail = (res.stderr || res.stdout).trim();
  if (res.code !== 0 && !isMissingProcessError(detail)) {
    throw new Error(`taskkill failed: ${detail || "unknown error"}`.trim());
  }
}

async function assertSchtasksAvailable() {
  const res = await execSchtasks(["/Query"]);
  if (res.code === 0) return;
  const detail = res.stderr || res.stdout;
  throw new Error(`schtasks unavailable: ${detail || "unknown error"}`.trim());
}

async function removeLegacyPidArtifact(env: Record<string, string | undefined>): Promise<void> {
  // Earlier versions tracked a PID file alongside the launcher. The launcher
  // path moved to daemon-launch.vbs and PID tracking is gone — clean up
  // both leftovers from upgraded installs.
  await fs.unlink(resolveLegacyLauncherPath(env)).catch(() => {});
  await fs.unlink(resolveLegacyPidPath(env)).catch(() => {});
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
  const xmlPath = resolveTaskDefinitionPath(env);
  await fs.mkdir(path.dirname(scriptPath), { recursive: true });
  const script = buildTaskScript({ programArguments, workingDirectory });
  await fs.writeFile(scriptPath, script, "utf8");
  const launcher = buildLauncherVbs({ programArguments, workingDirectory });
  await fs.writeFile(launcherPath, launcher, "utf8");
  await removeLegacyPidArtifact(env);

  const userPrincipal = resolveCurrentUserPrincipal(env);
  const xml = buildScheduledTaskXml({ launcherPath, userPrincipal });
  await fs.writeFile(xmlPath, xml, "utf8");

  const create = await execSchtasks([
    "/Create",
    "/F",
    "/TN",
    DAEMON_WINDOWS_TASK_NAME,
    "/XML",
    xmlPath,
  ]);
  if (create.code !== 0) {
    const detail = (create.stderr || create.stdout).trim();
    const hint = /access is denied/i.test(detail)
      ? " (run `summarize daemon install` from an elevated PowerShell/cmd — schtasks /Create /XML requires Administrator)"
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
  await killRunningDaemon(env);
  await execSchtasks(["/End", "/TN", DAEMON_WINDOWS_TASK_NAME]);
  await execSchtasks(["/Delete", "/F", "/TN", DAEMON_WINDOWS_TASK_NAME]);

  const scriptPath = resolveTaskScriptPath(env);
  try {
    await fs.unlink(scriptPath);
    stdout.write(`Removed task script: ${scriptPath}\n`);
  } catch {
    stdout.write(`Task script not found at ${scriptPath}\n`);
  }
  await fs.unlink(resolveTaskLauncherPath(env)).catch(() => {});
  await fs.unlink(resolveTaskDefinitionPath(env)).catch(() => {});
  await removeLegacyPidArtifact(env);
}

export async function restartScheduledTask({
  env,
  stdout,
}: {
  env: Record<string, string | undefined>;
  stdout: NodeJS.WritableStream;
}): Promise<void> {
  await assertSchtasksAvailable();
  await killRunningDaemon(env);
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
