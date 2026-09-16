import fs from "node:fs/promises";
import path from "node:path";
import { CliError, createCliTranslator, resolveCliLocaleFromEnv } from "../locale.js";
import { execDaemonCommand, serviceCommandError } from "./command.js";
import { DAEMON_SYSTEMD_SERVICE_NAME } from "./constants.js";

function resolveHomeDir(env: Record<string, string | undefined>): string {
  const home = env.HOME?.trim() || env.USERPROFILE?.trim();
  if (!home) throw new CliError("error.missingHome");
  return home;
}

function resolveSystemdUnitPath(env: Record<string, string | undefined>): string {
  const home = resolveHomeDir(env);
  return path.join(home, ".config", "systemd", "user", `${DAEMON_SYSTEMD_SERVICE_NAME}.service`);
}

function systemdEscapeArg(value: string): string {
  if (!/[\s"\\]/.test(value)) return value;
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function buildSystemdUnit({
  programArguments,
  workingDirectory,
}: {
  programArguments: string[];
  workingDirectory?: string;
}): string {
  const execStart = programArguments.map(systemdEscapeArg).join(" ");
  // i18n-ignore: systemd unit-file directive.
  const workingDirLine = workingDirectory
    ? `WorkingDirectory=${systemdEscapeArg(workingDirectory)}`
    : null;
  // i18n-ignore: systemd unit-file schema, not interface copy.
  return [
    "[Unit]",
    "Description=Summarize daemon",
    "",
    "[Service]",
    `ExecStart=${execStart}`,
    "Restart=always",
    workingDirLine,
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ]
    .filter((line) => line !== null)
    .join("\n");
}

function parseSystemdExecStart(value: string): string[] {
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

export async function readSystemdServiceExecStart(
  env: Record<string, string | undefined>,
): Promise<{ programArguments: string[]; workingDirectory?: string } | null> {
  const unitPath = resolveSystemdUnitPath(env);
  try {
    const content = await fs.readFile(unitPath, "utf8");
    let execStart = "";
    let workingDirectory = "";
    for (const rawLine of content.split("\n")) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;
      if (line.startsWith(/* i18n-ignore: systemd unit-file directive. */ "ExecStart=")) {
        // i18n-ignore: systemd unit-file directive.
        execStart = line.slice("ExecStart=".length).trim();
      } else if (
        line.startsWith(/* i18n-ignore: systemd unit-file directive. */ "WorkingDirectory=")
      ) {
        // i18n-ignore: systemd unit-file directive.
        workingDirectory = line.slice("WorkingDirectory=".length).trim();
      }
    }
    if (!execStart) return null;
    const programArguments = parseSystemdExecStart(execStart);
    return {
      programArguments,
      ...(workingDirectory ? { workingDirectory } : {}),
    };
  } catch {
    return null;
  }
}

const execSystemctl = (args: string[]) => execDaemonCommand("systemctl", args);

async function assertSystemdAvailable() {
  const res = await execSystemctl(["--user", "status"]);
  if (res.code === 0) return;
  const detail = res.stderr || res.stdout;
  if (
    detail
      .toLowerCase()
      .includes(/* i18n-ignore: systemctl diagnostic, not a UI label. */ "not found")
  ) {
    throw new CliError("service.systemdRequired");
  }
  throw serviceCommandError("systemctl --user", detail, "unavailable");
}

export async function installSystemdService({
  env,
  stdout,
  programArguments,
  workingDirectory,
}: {
  env: Record<string, string | undefined>;
  stdout: NodeJS.WritableStream;
  programArguments: string[];
  workingDirectory?: string;
}): Promise<{ unitPath: string }> {
  await assertSystemdAvailable();

  const unitPath = resolveSystemdUnitPath(env);
  await fs.mkdir(path.dirname(unitPath), { recursive: true });
  const unit = buildSystemdUnit({ programArguments, workingDirectory });
  await fs.writeFile(unitPath, unit, "utf8");

  const unitName = `${DAEMON_SYSTEMD_SERVICE_NAME}.service`;
  const reload = await execSystemctl(["--user", "daemon-reload"]);
  if (reload.code !== 0) {
    throw serviceCommandError("systemctl daemon-reload", reload.stderr || reload.stdout);
  }

  const enable = await execSystemctl(["--user", "enable", unitName]);
  if (enable.code !== 0) {
    throw serviceCommandError("systemctl enable", enable.stderr || enable.stdout);
  }

  const restart = await execSystemctl(["--user", "restart", unitName]);
  if (restart.code !== 0) {
    throw serviceCommandError("systemctl restart", restart.stderr || restart.stdout);
  }

  stdout.write(
    `${createCliTranslator(resolveCliLocaleFromEnv(env))("service.systemdInstalled", { path: unitPath })}\n`,
  );
  return { unitPath };
}

export async function uninstallSystemdService({
  env,
  stdout,
}: {
  env: Record<string, string | undefined>;
  stdout: NodeJS.WritableStream;
}): Promise<void> {
  await assertSystemdAvailable();
  const unitName = `${DAEMON_SYSTEMD_SERVICE_NAME}.service`;
  await execSystemctl(["--user", "disable", "--now", unitName]);

  const unitPath = resolveSystemdUnitPath(env);
  try {
    await fs.unlink(unitPath);
    stdout.write(
      `${createCliTranslator(resolveCliLocaleFromEnv(env))("service.systemdRemoved", { path: unitPath })}\n`,
    );
  } catch {
    stdout.write(
      `${createCliTranslator(resolveCliLocaleFromEnv(env))("service.systemdMissing", { path: unitPath })}\n`,
    );
  }
}

export async function restartSystemdService({
  stdout,
  env = {},
}: {
  env?: Record<string, string | undefined>;
  stdout: NodeJS.WritableStream;
}): Promise<void> {
  await assertSystemdAvailable();
  const unitName = `${DAEMON_SYSTEMD_SERVICE_NAME}.service`;
  const res = await execSystemctl(["--user", "restart", unitName]);
  if (res.code !== 0) {
    throw serviceCommandError("systemctl restart", res.stderr || res.stdout);
  }
  stdout.write(
    `${createCliTranslator(resolveCliLocaleFromEnv(env))("service.systemdRestarted", { name: unitName })}\n`,
  );
}

export async function isSystemdServiceEnabled(): Promise<boolean> {
  await assertSystemdAvailable();
  const unitName = `${DAEMON_SYSTEMD_SERVICE_NAME}.service`;
  const res = await execSystemctl(["--user", "is-enabled", unitName]);
  return res.code === 0;
}
