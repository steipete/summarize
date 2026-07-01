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

function readArgValue(argv: string[], name: string): string | null {
  const eq = argv.find((a) => a.startsWith(`${name}=`));
  if (eq) return eq.slice(`${name}=`.length).trim() || null;
  const index = argv.indexOf(name);
  if (index === -1) return null;
  const next = argv[index + 1];
  if (!next || next.startsWith("-")) return null;
  return next.trim() || null;
}

function wantHelp(argv: string[]): boolean {
  return argv.includes("--help") || argv.includes("-h") || argv.includes("help");
}

function hasArg(argv: string[], name: string): boolean {
  return argv.includes(name) || argv.some((a) => a.startsWith(`${name}=`));
}

function readPortArg(argv: string[]): number | null {
  const portRaw = readArgValue(argv, "--port");
  if (!portRaw) return null;
  const port = Number(portRaw);
  if (!Number.isFinite(port) || port <= 0 || port > 65535) throw new Error("Invalid --port");
  return Math.floor(port);
}

function readExtensionIdArg(argv: string[]): string | null {
  const extensionId = readArgValue(argv, "--extension-id");
  if (!extensionId) return null;
  if (!/^[a-p]{32}$/.test(extensionId)) throw new Error("Invalid --extension-id");
  return extensionId;
}

function writeWindowsContainerInstallInstructions({
  stdout,
  port,
  configPath,
  programArguments,
  workingDirectory,
}: {
  stdout: NodeJS.WritableStream;
  port: number;
  configPath: string;
  programArguments: string[];
  workingDirectory?: string;
}) {
  stdout.write("Windows container detected: skipped Scheduled Task registration.\n");
  stdout.write(`Daemon config: ${configPath}\n`);
  stdout.write(`Daemon command: ${formatProgramArguments(programArguments)}\n`);
  if (workingDirectory) {
    stdout.write(`Daemon cwd: ${workingDirectory}\n`);
  }
  stdout.write("Daemon autostart is not available in Windows container mode.\n");
  stdout.write(
    "Run `summarize daemon install --token <TOKEN>` each time the container starts, or add that command to your container startup.\n",
  );
  stdout.write(
    "Chrome Daemon mode also requires a packaged Windows native-host executable; use Direct/Browser modes until it is available.\n",
  );
}

export async function handleDaemonRequest({
  normalizedArgv,
  envForRun,
  fetchImpl,
  stdout,
  stderr,
}: DaemonCliContext): Promise<boolean> {
  if (normalizedArgv[0]?.toLowerCase() !== "daemon") return false;

  const sub = normalizedArgv[1]?.toLowerCase() ?? null;
  if (!sub || wantHelp(normalizedArgv)) {
    stdout.write(`${buildDaemonHelp()}\n`);
    return true;
  }

  if (sub === "install") {
    const token = readArgValue(normalizedArgv, "--token");
    if (!token) throw new Error("Missing --token");
    const requestedPort = readPortArg(normalizedArgv);
    const dev = hasArg(normalizedArgv, "--dev");
    const extensionId = readExtensionIdArg(normalizedArgv);
    if (extensionId && !dev) throw new Error("--extension-id is only available with --dev");

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
      if (!authed) throw new Error("Daemon is up but auth failed (token mismatch?)");
      writeWindowsContainerInstallInstructions({
        stdout,
        port,
        configPath,
        programArguments,
        workingDirectory,
      });
      stdout.write("OK: daemon is running in this container session and authenticated.\n");
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
    if (!authed) throw new Error("Daemon is up but auth failed (token mismatch?)");

    stdout.write(`Daemon config: ${configPath}\n`);
    stdout.write(
      nativeHost.installed
        ? `Chrome native messaging host: ${nativeHost.manifestPath}\n`
        : `Chrome native messaging host: unavailable (${nativeHost.reason})\n`,
    );
    const installedCommand = await readInstalledDaemonCommand(envForRun);
    if (installedCommand?.programArguments?.length) {
      stdout.write(
        `Daemon command: ${formatProgramArguments(installedCommand.programArguments)}\n`,
      );
      if (installedCommand.workingDirectory) {
        stdout.write(`Daemon cwd: ${installedCommand.workingDirectory}\n`);
      }
    }
    stdout.write(`OK: daemon is running and authenticated.\n`);
    return true;
  }

  if (sub === "status") {
    const cfg = await readDaemonConfig({ env: envForRun });
    if (!cfg) {
      stdout.write("Daemon not installed (missing ~/.summarize/daemon.json)\n");
      stdout.write("Run: summarize daemon install --token <token>\n");
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
      stdout.write("Autostart: manual (Windows container mode; no Scheduled Task)\n");
      stdout.write(`Daemon: ${healthy ? `up on ${DAEMON_HOST}:${cfg.port}` : "down"}\n`);
      stdout.write(`Auth: ${authed ? "ok" : "failed"}\n`);
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

    stdout.write(`${service.label}: ${loaded ? service.loadedText : service.notLoadedText}\n`);
    stdout.write(
      `Chrome native messaging host: ${nativeHostInstalled ? "installed" : "missing"}\n`,
    );
    stdout.write(`Daemon: ${healthy ? `up on ${DAEMON_HOST}:${cfg.port}` : "down"}\n`);
    stdout.write(`Auth: ${authed ? "ok" : "failed"}\n`);
    return true;
  }

  if (sub === "restart") {
    const cfg = await readDaemonConfig({ env: envForRun });
    if (!cfg) {
      stdout.write("Daemon not installed (missing ~/.summarize/daemon.json)\n");
      stdout.write("Run: summarize daemon install --token <token>\n");
      return true;
    }
    if (process.platform === "win32" && isWindowsContainerEnvironment(envForRun)) {
      stdout.write(
        "Autostart is manual in Windows container mode; no Scheduled Task is registered.\n",
      );
      stdout.write(
        "Restart the container or rerun `summarize daemon install --token <token>` to start the daemon again.\n",
      );
      return true;
    }
    const service = resolveDaemonService();
    const loaded = await service.isLoaded({ env: envForRun });
    if (!loaded) {
      stdout.write(
        `${service.label} ${service.notLoadedText}. Run: summarize daemon install --token <token>\n`,
      );
      return true;
    }

    await service.restart({ env: envForRun, stdout });
    const installedCommand = await readInstalledDaemonCommand(envForRun);
    if (installedCommand?.programArguments?.length) {
      stdout.write(
        `Daemon command: ${formatProgramArguments(installedCommand.programArguments)}\n`,
      );
      if (installedCommand.workingDirectory) {
        stdout.write(`Daemon cwd: ${installedCommand.workingDirectory}\n`);
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
      stdout.write(
        'Restarted daemon. It is still starting; run "summarize daemon status" in a few seconds.\n',
      );
      return true;
    }

    stdout.write("OK: daemon restarted and authenticated.\n");
    return true;
  }

  if (sub === "uninstall") {
    await uninstallNativeMessagingHost({ env: envForRun });
    if (process.platform === "win32" && isWindowsContainerEnvironment(envForRun)) {
      stdout.write(
        "Uninstalled (Windows container mode does not register Scheduled Task autostart). Config left in ~/.summarize/daemon.json\n",
      );
      return true;
    }
    const service = resolveDaemonService();
    await service.uninstall({ env: envForRun, stdout });
    stdout.write(
      "Uninstalled (daemon autostart removed). Config left in ~/.summarize/daemon.json\n",
    );
    return true;
  }

  if (sub === "run") {
    const existingConfig = await readDaemonConfig({ env: envForRun });
    const tokenOverride = readArgValue(normalizedArgv, "--token")?.trim() || null;
    const port = readPortArg(normalizedArgv) ?? existingConfig?.port ?? DAEMON_PORT_DEFAULT;
    if (!existingConfig && !tokenOverride) {
      stderr.write("Missing ~/.summarize/daemon.json\n");
      stderr.write("Run: summarize daemon install --token <token>\n");
      stderr.write("For a foreground dev run, pass --token <token>.\n");
      throw new Error("Daemon not configured");
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

  stdout.write(`${buildDaemonHelp()}\n`);
  return true;
}
