import fs from "node:fs/promises";
import path from "node:path";
import { execDaemonCommand, type DaemonCommandResult } from "./command.js";
import { DAEMON_LAUNCH_AGENT_LABEL } from "./constants.js";

function resolveHomeDir(env: Record<string, string | undefined>): string {
  const home = env.HOME?.trim() || env.USERPROFILE?.trim();
  if (!home) throw new Error("Missing HOME");
  return home;
}

export function resolveLaunchAgentPlistPath(env: Record<string, string | undefined>): string {
  const home = resolveHomeDir(env);
  return path.join(home, "Library", "LaunchAgents", `${DAEMON_LAUNCH_AGENT_LABEL}.plist`);
}

export function resolveDaemonLogPaths(env: Record<string, string | undefined>): {
  logDir: string;
  stdoutPath: string;
  stderrPath: string;
} {
  const home = resolveHomeDir(env);
  const logDir = path.join(home, ".summarize", "logs");
  return {
    logDir,
    stdoutPath: path.join(logDir, "daemon.log"),
    stderrPath: path.join(logDir, "daemon.err.log"),
  };
}

function plistEscape(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function plistUnescape(value: string): string {
  return value
    .replaceAll("&apos;", "'")
    .replaceAll("&quot;", '"')
    .replaceAll("&gt;", ">")
    .replaceAll("&lt;", "<")
    .replaceAll("&amp;", "&");
}

export async function readLaunchAgentProgramArguments(
  env: Record<string, string | undefined>,
): Promise<{ programArguments: string[]; workingDirectory?: string } | null> {
  const plistPath = resolveLaunchAgentPlistPath(env);
  try {
    const plist = await fs.readFile(plistPath, "utf8");
    const programMatch = plist.match(/<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/i);
    if (!programMatch) return null;
    const args = Array.from(programMatch[1].matchAll(/<string>([\s\S]*?)<\/string>/gi)).map(
      (match) => plistUnescape(match[1] ?? "").trim(),
    );
    const workingDirMatch = plist.match(
      /<key>WorkingDirectory<\/key>\s*<string>([\s\S]*?)<\/string>/i,
    );
    const workingDirectory = workingDirMatch ? plistUnescape(workingDirMatch[1] ?? "").trim() : "";
    return {
      programArguments: args.filter(Boolean),
      ...(workingDirectory ? { workingDirectory } : {}),
    };
  } catch {
    return null;
  }
}

export function buildLaunchAgentPlist({
  label = DAEMON_LAUNCH_AGENT_LABEL,
  programArguments,
  workingDirectory,
  stdoutPath,
  stderrPath,
}: {
  label?: string;
  programArguments: string[];
  workingDirectory?: string;
  stdoutPath: string;
  stderrPath: string;
}): string {
  const argsXml = programArguments
    .map((arg) => `\n      <string>${plistEscape(arg)}</string>`)
    .join("");
  const workingDirXml = workingDirectory
    ? `
    <key>WorkingDirectory</key>
    <string>${plistEscape(workingDirectory)}</string>`
    : "";
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>${plistEscape(label)}</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>ProgramArguments</key>
    <array>${argsXml}
    </array>
    ${workingDirXml}
    <key>StandardOutPath</key>
    <string>${plistEscape(stdoutPath)}</string>
    <key>StandardErrorPath</key>
    <string>${plistEscape(stderrPath)}</string>
  </dict>
</plist>
`;
}

const execLaunchctl = (args: string[]) => execDaemonCommand("launchctl", args);

function parseUid(raw: string | undefined): number | null {
  if (!raw) return null;
  const value = Number(raw.trim());
  if (!Number.isInteger(value) || value < 0) return null;
  return value;
}

export function resolveLaunchctlTargetUid({
  uid,
  sudoUid,
}: {
  uid?: number;
  sudoUid?: string;
} = {}): number {
  const currentUid =
    typeof uid === "number" ? uid : typeof process.getuid === "function" ? process.getuid() : null;
  if (currentUid === 0) {
    const sudo = parseUid(sudoUid ?? process.env.SUDO_UID);
    if (sudo !== null) return sudo;
  }
  if (typeof currentUid === "number" && currentUid >= 0) return currentUid;
  const fallbackSudo = parseUid(sudoUid ?? process.env.SUDO_UID);
  if (fallbackSudo !== null) return fallbackSudo;
  return 501;
}

export function resolveLaunchctlDomains({
  uid,
  sudoUid,
}: {
  uid?: number;
  sudoUid?: string;
} = {}): string[] {
  const targetUid = resolveLaunchctlTargetUid({ uid, sudoUid });
  return [`gui/${targetUid}`, `user/${targetUid}`];
}

export async function isLaunchAgentLoaded(): Promise<boolean> {
  const label = DAEMON_LAUNCH_AGENT_LABEL;
  const domains = resolveLaunchctlDomains();
  for (const domain of domains) {
    const res = await execLaunchctl(["print", `${domain}/${label}`]);
    if (res.code === 0) return true;
  }
  return false;
}

export async function uninstallLaunchAgent({
  env,
  stdout,
}: {
  env: Record<string, string | undefined>;
  stdout: NodeJS.WritableStream;
}): Promise<void> {
  const domains = resolveLaunchctlDomains();
  const plistPath = resolveLaunchAgentPlistPath(env);
  for (const domain of domains) {
    await execLaunchctl(["bootout", domain, plistPath]);
  }
  await execLaunchctl(["unload", plistPath]);

  try {
    await fs.access(plistPath);
  } catch {
    stdout.write(`LaunchAgent not found at ${plistPath}\n`);
    return;
  }

  const home = resolveHomeDir(env);
  const trashDir = path.join(home, ".Trash");
  const dest = path.join(trashDir, `${DAEMON_LAUNCH_AGENT_LABEL}.plist`);
  try {
    await fs.mkdir(trashDir, { recursive: true });
    await fs.rename(plistPath, dest);
    stdout.write(`Moved LaunchAgent to Trash: ${dest}\n`);
  } catch {
    // If rename fails (e.g. different volume), leave it and just report.
    stdout.write(`LaunchAgent remains at ${plistPath} (could not move to Trash)\n`);
  }
}

export async function installLaunchAgent({
  env,
  stdout,
  programArguments,
  workingDirectory,
}: {
  env: Record<string, string | undefined>;
  stdout: NodeJS.WritableStream;
  programArguments: string[];
  workingDirectory?: string;
}): Promise<{ plistPath: string }> {
  const { logDir, stdoutPath, stderrPath } = resolveDaemonLogPaths(env);
  await fs.mkdir(logDir, { recursive: true });

  const plistPath = resolveLaunchAgentPlistPath(env);
  await fs.mkdir(path.dirname(plistPath), { recursive: true });

  const plist = buildLaunchAgentPlist({
    programArguments,
    workingDirectory,
    stdoutPath,
    stderrPath,
  });
  await fs.writeFile(plistPath, plist, "utf8");

  const domains = resolveLaunchctlDomains();
  for (const domain of domains) {
    await execLaunchctl(["bootout", domain, plistPath]);
  }
  await execLaunchctl(["unload", plistPath]);
  let installedDomain: string | null = null;
  let lastBootstrap: DaemonCommandResult | null = null;
  for (const domain of domains) {
    const boot = await execLaunchctl(["bootstrap", domain, plistPath]);
    if (boot.code === 0) {
      installedDomain = domain;
      break;
    }
    lastBootstrap = boot;
  }
  if (!installedDomain) {
    const details = lastBootstrap?.stderr || lastBootstrap?.stdout || "unknown error";
    throw new Error(`launchctl bootstrap failed: ${details}`.trim());
  }
  await execLaunchctl(["enable", `${installedDomain}/${DAEMON_LAUNCH_AGENT_LABEL}`]);
  await execLaunchctl(["kickstart", "-k", `${installedDomain}/${DAEMON_LAUNCH_AGENT_LABEL}`]);

  stdout.write(`Installed LaunchAgent: ${plistPath}\n`);
  stdout.write(`Launch domain: ${installedDomain}\n`);
  stdout.write(`Logs: ${stdoutPath}\n`);
  return { plistPath };
}

export async function restartLaunchAgent({
  stdout,
}: {
  stdout: NodeJS.WritableStream;
}): Promise<void> {
  const label = DAEMON_LAUNCH_AGENT_LABEL;
  const domains = resolveLaunchctlDomains();
  let lastResult: DaemonCommandResult | null = null;
  for (const domain of domains) {
    const res = await execLaunchctl(["kickstart", "-k", `${domain}/${label}`]);
    if (res.code === 0) {
      stdout.write(`Restarted LaunchAgent: ${domain}/${label}\n`);
      return;
    }
    lastResult = res;
  }
  throw new Error(
    `launchctl kickstart failed: ${lastResult?.stderr || lastResult?.stdout || "unknown error"}`.trim(),
  );
}
