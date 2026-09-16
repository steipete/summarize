import { readCliOptionValue } from "../cli-args.js";
import { CliError } from "../locale.js";
import { type CliLocale, createCliTranslator, resolveCliLocaleFromEnv } from "../locale.js";
import { buildDaemonHelp } from "../run/help.js";
import {
  checkAuth,
  checkAuthWithRetries,
  sleep,
  waitForHealth,
  waitForHealthWithRetries,
} from "./cli-health.js";
import {
  formatProgramArguments,
  readInstalledDaemonCommand,
  resolveDaemonProgramArguments,
  resolveDaemonService,
  startDetachedContainerDaemon,
} from "./cli-service.js";
import {
  daemonConfigPrimaryToken,
  daemonConfigTokens,
  readDaemonConfig,
  writeDaemonConfig,
} from "./config.js";
import { DAEMON_HOST, DAEMON_PORT_DEFAULT } from "./constants.js";
import { mergeDaemonEnv } from "./env-merge.js";
import { buildEnvSnapshotFromEnv } from "./env-snapshot.js";
import {
  installNativeMessagingHost,
  isNativeMessagingHostInstalled,
  uninstallNativeMessagingHost,
} from "./native-messaging-install.js";
import { runNativeMessagingHost } from "./native-messaging.js";
import { runDaemonServer } from "./server.js";
import { isWindowsContainerEnvironment } from "./windows-container.js";

type DaemonCliContext = {
  normalizedArgv: string[];
  envForRun: Record<string, string | undefined>;
  fetchImpl: typeof fetch;
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
};

function wantHelp(argv: string[]): boolean {
  return argv.includes("--help") || argv.includes("-h") || argv.includes("help");
}

function hasArg(argv: string[], name: string): boolean {
  return argv.includes(name) || argv.some((a) => a.startsWith(`${name}=`));
}

function readPortArg(argv: string[]): number | null {
  const portRaw = readCliOptionValue(argv, "--port");
  if (!portRaw) return null;
  const port = Number(portRaw);
  if (!Number.isFinite(port) || port <= 0 || port > 65535) throw new CliError("error.daemonPort");
  return Math.floor(port);
}

function readExtensionIdArg(argv: string[]): string | null {
  const extensionId = readCliOptionValue(argv, "--extension-id");
  if (!extensionId) return null;
  if (!/^[a-p]{32}$/.test(extensionId)) throw new CliError("error.extensionId");
  return extensionId;
}

function writeWindowsContainerInstallInstructions({
  stdout,
  configPath,
  programArguments,
  workingDirectory,
  locale,
}: {
  locale: CliLocale;
  stdout: NodeJS.WritableStream;
  configPath: string;
  programArguments: string[];
  workingDirectory?: string;
}) {
  const t = createCliTranslator(locale);
  stdout.write(`${t("daemon.windowsDetected")}\n`);
  stdout.write(`${t("daemon.configPath", { value: configPath })}\n`);
  stdout.write(`${t("daemon.command", { value: formatProgramArguments(programArguments) })}\n`);
  if (workingDirectory) {
    stdout.write(`${t("daemon.cwd", { value: workingDirectory })}\n`);
  }
  stdout.write(`${t("daemon.windowsNoAutostart")}\n`);
  stdout.write(`${t("daemon.windowsInstallHint")}\n`);
  stdout.write(`${t("daemon.windowsNativeHint")}\n`);
}

export async function handleDaemonRequest({
  normalizedArgv,
  envForRun,
  fetchImpl,
  stdout,
  stderr,
}: DaemonCliContext): Promise<boolean> {
  if (normalizedArgv[0]?.toLowerCase() !== "daemon") return false;

  const locale = resolveCliLocaleFromEnv(envForRun);
  const t = createCliTranslator(locale);
  const sub = normalizedArgv[1]?.toLowerCase() ?? null;
  if (!sub || wantHelp(normalizedArgv)) {
    stdout.write(`${buildDaemonHelp(locale)}\n`);
    return true;
  }

  if (sub === "install") {
    const token = readCliOptionValue(normalizedArgv, "--token");
    if (!token) throw new CliError("error.daemonToken");
    const requestedPort = readPortArg(normalizedArgv);
    const dev = hasArg(normalizedArgv, "--dev");
    const extensionId = readExtensionIdArg(normalizedArgv);
    if (extensionId && !dev) throw new CliError("error.extensionDevOnly");

    const envSnapshot = buildEnvSnapshotFromEnv(envForRun);
    const existingConfig = await readDaemonConfig({ env: envForRun });
    const port = requestedPort ?? existingConfig?.port ?? DAEMON_PORT_DEFAULT;
    const mergedTokens = existingConfig
      ? Array.from(new Set([...daemonConfigTokens(existingConfig), token.trim()]))
      : [token.trim()];
    const configPath = await writeDaemonConfig({
      env: envForRun,
      config: {
        token: existingConfig ? daemonConfigPrimaryToken(existingConfig) : token,
        tokens: mergedTokens,
        port,
        env: envSnapshot,
      },
    });

    const windowsContainerMode =
      process.platform === "win32" && isWindowsContainerEnvironment(envForRun);

    if (windowsContainerMode) {
      const { programArguments, workingDirectory } = await resolveDaemonProgramArguments({ dev });
      await startDetachedContainerDaemon({
        env: envForRun,
        programArguments,
        workingDirectory,
      });
      await waitForHealthWithRetries({
        fetchImpl,
        port,
        attempts: 5,
        timeoutMs: 5000,
        delayMs: 500,
      });
      const authed = await checkAuthWithRetries({
        fetchImpl,
        token: token.trim(),
        port,
        attempts: 5,
        delayMs: 400,
      });
      if (!authed) throw new CliError("error.daemonAuth");
      writeWindowsContainerInstallInstructions({
        locale,
        stdout,
        configPath,
        programArguments,
        workingDirectory,
      });
      stdout.write(`${t("daemon.containerReady")}\n`);
      return true;
    }

    const { programArguments, workingDirectory } = await resolveDaemonProgramArguments({ dev });
    const service = resolveDaemonService();
    await service.install({ env: envForRun, stdout, programArguments, workingDirectory });
    const nativeProgram = await resolveDaemonProgramArguments({ dev, subcommand: "native-host" });
    if (extensionId) nativeProgram.programArguments.push("--extension-id", extensionId);
    const nativeHost = await installNativeMessagingHost({
      env: envForRun,
      program: nativeProgram,
      extensionId: extensionId ?? undefined,
    });
    await waitForHealthWithRetries({ fetchImpl, port, attempts: 5, timeoutMs: 5000, delayMs: 500 });
    const authed = await checkAuthWithRetries({
      fetchImpl,
      token: token.trim(),
      port,
      attempts: 5,
      delayMs: 400,
    });
    if (!authed) throw new CliError("error.daemonAuth");

    stdout.write(`${t("daemon.configPath", { value: configPath })}\n`);
    stdout.write(
      nativeHost.installed
        ? `${t("daemon.nativePath", { value: nativeHost.manifestPath ?? "" })}\n`
        : `${t("daemon.nativeUnavailable", { reason: nativeHost.reason ?? "" })}\n`,
    );
    const installedCommand = await readInstalledDaemonCommand(envForRun);
    if (installedCommand?.programArguments?.length) {
      stdout.write(
        `${t("daemon.command", { value: formatProgramArguments(installedCommand.programArguments) })}\n`,
      );
      if (installedCommand.workingDirectory) {
        stdout.write(`${t("daemon.cwd", { value: installedCommand.workingDirectory })}\n`);
      }
    }
    stdout.write(`${t("daemon.ready")}\n`);
    return true;
  }

  if (sub === "status") {
    const cfg = await readDaemonConfig({ env: envForRun });
    if (!cfg) {
      stdout.write(`${t("daemon.notInstalled")}\n`);
      stdout.write(`${t("daemon.installHint")}\n`);
      return true;
    }
    if (process.platform === "win32" && isWindowsContainerEnvironment(envForRun)) {
      const healthy = await (async () => {
        try {
          await waitForHealth({ fetchImpl, port: cfg.port, timeoutMs: 1000 });
          return true;
        } catch {
          return false;
        }
      })();
      const authed = healthy
        ? await checkAuth({ fetchImpl, token: daemonConfigPrimaryToken(cfg), port: cfg.port })
        : false;
      stdout.write(`${t("daemon.manualAutostart")}\n`);
      stdout.write(t("daemon.health", { healthy, address: `${DAEMON_HOST}:${cfg.port}` }) + "\n");
      stdout.write(t("daemon.auth", { ok: authed }) + "\n");
      return true;
    }
    const service = resolveDaemonService();
    const loaded = await service.isLoaded({ env: envForRun });
    const nativeHostInstalled = await isNativeMessagingHostInstalled({ env: envForRun });
    const healthy = await (async () => {
      try {
        await waitForHealth({ fetchImpl, port: cfg.port, timeoutMs: 1000 });
        return true;
      } catch {
        return false;
      }
    })();
    const authed = healthy
      ? await checkAuth({ fetchImpl, token: daemonConfigPrimaryToken(cfg), port: cfg.port })
      : false;

    stdout.write(
      t("daemon.service", {
        service: service.label,
        state: (loaded ? service.loadedText : service.notLoadedText).replaceAll(" ", "_"),
      }) + "\n",
    );
    stdout.write(t("daemon.nativeStatus", { installed: nativeHostInstalled }) + "\n");
    stdout.write(t("daemon.health", { healthy, address: `${DAEMON_HOST}:${cfg.port}` }) + "\n");
    stdout.write(t("daemon.auth", { ok: authed }) + "\n");
    return true;
  }

  if (sub === "restart") {
    const cfg = await readDaemonConfig({ env: envForRun });
    if (!cfg) {
      stdout.write(`${t("daemon.notInstalled")}\n`);
      stdout.write(`${t("daemon.installHint")}\n`);
      return true;
    }
    if (process.platform === "win32" && isWindowsContainerEnvironment(envForRun)) {
      stdout.write(`${t("daemon.windowsManual")}\n`);
      stdout.write(`${t("daemon.windowsRestart")}\n`);
      return true;
    }
    const service = resolveDaemonService();
    const loaded = await service.isLoaded({ env: envForRun });
    if (!loaded) {
      stdout.write(`${t("daemon.serviceMissing", { service: service.label })}\n`);
      return true;
    }

    await service.restart({ env: envForRun, stdout });
    const installedCommand = await readInstalledDaemonCommand(envForRun);
    if (installedCommand?.programArguments?.length) {
      stdout.write(
        `${t("daemon.command", { value: formatProgramArguments(installedCommand.programArguments) })}\n`,
      );
      if (installedCommand.workingDirectory) {
        stdout.write(`${t("daemon.cwd", { value: installedCommand.workingDirectory })}\n`);
      }
    }
    await sleep(8000);
    let healthy = true;
    try {
      await waitForHealthWithRetries({
        fetchImpl,
        port: cfg.port,
        attempts: 3,
        timeoutMs: 15000,
        delayMs: 500,
      });
    } catch {
      healthy = false;
    }
    const authed = healthy
      ? await checkAuthWithRetries({
          fetchImpl,
          token: daemonConfigPrimaryToken(cfg),
          port: cfg.port,
          attempts: 5,
          delayMs: 400,
        })
      : false;
    if (!healthy || !authed) {
      stdout.write(`${t("daemon.starting")}\n`);
      return true;
    }

    stdout.write(`${t("daemon.restarted")}\n`);
    return true;
  }

  if (sub === "uninstall") {
    await uninstallNativeMessagingHost({ env: envForRun });
    if (process.platform === "win32" && isWindowsContainerEnvironment(envForRun)) {
      stdout.write(`${t("daemon.windowsUninstalled")}\n`);
      return true;
    }
    const service = resolveDaemonService();
    await service.uninstall({ env: envForRun, stdout });
    stdout.write(`${t("daemon.uninstalled")}\n`);
    return true;
  }

  if (sub === "run") {
    const existingConfig = await readDaemonConfig({ env: envForRun });
    const tokenOverride = readCliOptionValue(normalizedArgv, "--token")?.trim() || null;
    const port = readPortArg(normalizedArgv) ?? existingConfig?.port ?? DAEMON_PORT_DEFAULT;
    if (!existingConfig && !tokenOverride) {
      stderr.write(`${t("daemon.configMissing")}\n`);
      stderr.write(`${t("daemon.installHint")}\n`);
      stderr.write(`${t("daemon.foregroundToken")}\n`);
      throw new CliError("error.daemonUnconfigured");
    }
    const cfg = existingConfig
      ? {
          ...existingConfig,
          token: tokenOverride ?? daemonConfigPrimaryToken(existingConfig),
          tokens: tokenOverride
            ? Array.from(new Set([...daemonConfigTokens(existingConfig), tokenOverride]))
            : daemonConfigTokens(existingConfig),
          port,
        }
      : {
          version: 2 as const,
          token: tokenOverride!,
          tokens: [tokenOverride!],
          port,
          env: buildEnvSnapshotFromEnv(envForRun),
          installedAt: new Date().toISOString(),
        };
    const mergedEnv = mergeDaemonEnv({ envForRun, snapshot: cfg.env });
    // Apply snapshot env to process.env so child processes (yt-dlp, ffmpeg,
    // deno, tesseract) inherit the correct PATH and tool config under
    // launchd/systemd where the default environment is minimal.
    for (const [key, value] of Object.entries(cfg.env)) {
      if (typeof value === "string") {
        process.env[key] = value;
      }
    }
    await runDaemonServer({ env: mergedEnv, fetchImpl, config: cfg });
    return true;
  }

  if (sub === "native-host") {
    const extensionId = readExtensionIdArg(normalizedArgv.slice(2));
    await runNativeMessagingHost({
      env: envForRun,
      argv: normalizedArgv.slice(2),
      stdin: process.stdin,
      stdout: process.stdout,
      extensionId: extensionId ?? undefined,
      fetchImpl,
    });
    return true;
  }

  stdout.write(`${buildDaemonHelp(locale)}\n`);
  return true;
}
