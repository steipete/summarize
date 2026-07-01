import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  spawn: vi.fn(),
  readDaemonConfig: vi.fn(),
  writeDaemonConfig: vi.fn(),
  runDaemonServer: vi.fn(),
  resolveCliEntrypointPathForService: vi.fn(),
  installLaunchAgent: vi.fn(),
  isLaunchAgentLoaded: vi.fn(),
  readLaunchAgentProgramArguments: vi.fn(),
  restartLaunchAgent: vi.fn(),
  uninstallLaunchAgent: vi.fn(),
  installSystemdService: vi.fn(),
  isSystemdServiceEnabled: vi.fn(),
  readSystemdServiceExecStart: vi.fn(),
  restartSystemdService: vi.fn(),
  uninstallSystemdService: vi.fn(),
  installScheduledTask: vi.fn(),
  isWindowsContainerEnvironment: vi.fn(),
  isScheduledTaskInstalled: vi.fn(),
  readScheduledTaskCommand: vi.fn(),
  restartScheduledTask: vi.fn(),
  uninstallScheduledTask: vi.fn(),
  installNativeMessagingHost: vi.fn(),
  isNativeMessagingHostInstalled: vi.fn(),
  uninstallNativeMessagingHost: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  spawn: mocks.spawn,
}));

vi.mock("../src/daemon/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/daemon/config.js")>();
  return {
    ...actual,
    readDaemonConfig: mocks.readDaemonConfig,
    writeDaemonConfig: mocks.writeDaemonConfig,
  };
});

vi.mock("../src/daemon/server.js", () => ({
  runDaemonServer: mocks.runDaemonServer,
}));

vi.mock("../src/daemon/cli-entrypoint.js", () => ({
  resolveCliEntrypointPathForService: mocks.resolveCliEntrypointPathForService,
}));

vi.mock("../src/daemon/launchd.js", () => ({
  installLaunchAgent: mocks.installLaunchAgent,
  isLaunchAgentLoaded: mocks.isLaunchAgentLoaded,
  readLaunchAgentProgramArguments: mocks.readLaunchAgentProgramArguments,
  restartLaunchAgent: mocks.restartLaunchAgent,
  uninstallLaunchAgent: mocks.uninstallLaunchAgent,
  resolveDaemonLogPaths: () => ({
    logDir: "/tmp/.summarize/logs",
    stdoutPath: "/tmp/.summarize/logs/daemon.log",
    stderrPath: "/tmp/.summarize/logs/daemon.err.log",
  }),
}));

vi.mock("../src/daemon/systemd.js", () => ({
  installSystemdService: mocks.installSystemdService,
  isSystemdServiceEnabled: mocks.isSystemdServiceEnabled,
  readSystemdServiceExecStart: mocks.readSystemdServiceExecStart,
  restartSystemdService: mocks.restartSystemdService,
  uninstallSystemdService: mocks.uninstallSystemdService,
}));

vi.mock("../src/daemon/schtasks.js", () => ({
  installScheduledTask: mocks.installScheduledTask,
  isScheduledTaskInstalled: mocks.isScheduledTaskInstalled,
  readScheduledTaskCommand: mocks.readScheduledTaskCommand,
  restartScheduledTask: mocks.restartScheduledTask,
  uninstallScheduledTask: mocks.uninstallScheduledTask,
}));

vi.mock("../src/daemon/windows-container.js", () => ({
  isWindowsContainerEnvironment: mocks.isWindowsContainerEnvironment,
}));

vi.mock("../src/daemon/native-messaging-install.js", () => ({
  installNativeMessagingHost: mocks.installNativeMessagingHost,
  isNativeMessagingHostInstalled: mocks.isNativeMessagingHostInstalled,
  uninstallNativeMessagingHost: mocks.uninstallNativeMessagingHost,
}));

import { handleDaemonRequest } from "../src/daemon/cli.js";

describe("daemon cli", () => {
  const originalPath = process.env.PATH;
  const originalOpenAiKey = process.env.OPENAI_API_KEY;
  const originalHome = process.env.HOME;
  const originalPlatform = process.platform;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.PATH = "/usr/bin:/bin";
    process.env.OPENAI_API_KEY = "from-process";
    process.env.HOME = "/tmp/original-home";
    mocks.resolveCliEntrypointPathForService.mockResolvedValue("/usr/local/bin/summarize-cli.js");
    mocks.readLaunchAgentProgramArguments.mockResolvedValue(null);
    mocks.readSystemdServiceExecStart.mockResolvedValue(null);
    mocks.readScheduledTaskCommand.mockResolvedValue(null);
    mocks.isWindowsContainerEnvironment.mockReturnValue(false);
    mocks.installLaunchAgent.mockResolvedValue(undefined);
    mocks.installSystemdService.mockResolvedValue(undefined);
    mocks.installScheduledTask.mockResolvedValue(undefined);
    mocks.installNativeMessagingHost.mockResolvedValue({
      installed: true,
      manifestPath: "/tmp/native-host.json",
      launcherPath: "/tmp/native-host",
    });
    mocks.isNativeMessagingHostInstalled.mockResolvedValue(true);
    mocks.uninstallNativeMessagingHost.mockResolvedValue(undefined);
    mocks.spawn.mockReturnValue({ unref: vi.fn() });
  });

  afterEach(() => {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    if (originalOpenAiKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalOpenAiKey;
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    Object.defineProperty(process, "platform", { value: originalPlatform });
  });

  it("applies daemon snapshot env to process.env for child processes on run (#99)", async () => {
    mocks.readDaemonConfig.mockResolvedValueOnce({
      token: "test-token",
      port: 8787,
      env: {
        PATH: "/opt/homebrew/bin:/usr/bin:/bin",
        OPENAI_API_KEY: "from-snapshot",
      },
    });
    mocks.runDaemonServer.mockResolvedValueOnce(undefined);

    const envForRun = {
      HOME: "/Users/peter",
      PATH: "/usr/bin:/bin",
      OPENAI_API_KEY: "from-run",
    };

    const handled = await handleDaemonRequest({
      normalizedArgv: ["daemon", "run"],
      envForRun,
      fetchImpl: fetch,
      stdout: new PassThrough(),
      stderr: new PassThrough(),
    });

    expect(handled).toBe(true);
    expect(mocks.readDaemonConfig).toHaveBeenCalledWith({ env: envForRun });
    expect(mocks.runDaemonServer).toHaveBeenCalledWith({
      env: {
        HOME: "/Users/peter",
        PATH: "/opt/homebrew/bin:/usr/bin:/bin",
        OPENAI_API_KEY: "from-snapshot",
      },
      fetchImpl: fetch,
      config: expect.objectContaining({
        token: "test-token",
        tokens: ["test-token"],
        port: 8787,
        env: {
          PATH: "/opt/homebrew/bin:/usr/bin:/bin",
          OPENAI_API_KEY: "from-snapshot",
        },
      }),
    });

    expect(process.env.PATH).toBe("/opt/homebrew/bin:/usr/bin:/bin");
    expect(process.env.OPENAI_API_KEY).toBe("from-snapshot");
    expect(process.env.HOME).toBe("/tmp/original-home");
  });

  it("supports foreground run with explicit token and port without installed config", async () => {
    mocks.readDaemonConfig.mockResolvedValueOnce(null);
    mocks.runDaemonServer.mockResolvedValueOnce(undefined);

    const envForRun = {
      HOME: "/Users/peter",
      PATH: "/usr/bin:/bin",
      OPENAI_API_KEY: "from-run",
    };

    const handled = await handleDaemonRequest({
      normalizedArgv: ["daemon", "run", "--token", "dev-token-123456", "--port", "65535"],
      envForRun,
      fetchImpl: fetch,
      stdout: new PassThrough(),
      stderr: new PassThrough(),
    });

    expect(handled).toBe(true);
    expect(mocks.runDaemonServer).toHaveBeenCalledWith({
      env: envForRun,
      fetchImpl: fetch,
      config: expect.objectContaining({
        version: 2,
        token: "dev-token-123456",
        tokens: ["dev-token-123456"],
        port: 65535,
        env: expect.objectContaining({
          PATH: "/usr/bin:/bin",
          OPENAI_API_KEY: "from-run",
        }),
      }),
    });
  });

  it("lets foreground run override port and add a temporary token", async () => {
    mocks.readDaemonConfig.mockResolvedValueOnce({
      version: 2,
      token: "installed-token-123456",
      tokens: ["installed-token-123456"],
      port: 8787,
      env: { PATH: "/opt/homebrew/bin:/usr/bin:/bin" },
      installedAt: "2026-01-01T00:00:00.000Z",
    });
    mocks.runDaemonServer.mockResolvedValueOnce(undefined);

    const envForRun = { HOME: "/Users/peter", PATH: "/usr/bin:/bin" };

    const handled = await handleDaemonRequest({
      normalizedArgv: ["daemon", "run", "--token=dev-token-123456", "--port=18787"],
      envForRun,
      fetchImpl: fetch,
      stdout: new PassThrough(),
      stderr: new PassThrough(),
    });

    expect(handled).toBe(true);
    expect(mocks.runDaemonServer).toHaveBeenCalledWith({
      env: {
        HOME: "/Users/peter",
        PATH: "/opt/homebrew/bin:/usr/bin:/bin",
      },
      fetchImpl: fetch,
      config: expect.objectContaining({
        token: "dev-token-123456",
        tokens: ["installed-token-123456", "dev-token-123456"],
        port: 18787,
      }),
    });
  });

  it("appends a new daemon token on install instead of replacing existing tokens", async () => {
    mocks.readDaemonConfig.mockResolvedValueOnce({
      version: 2,
      token: "existing-token-1234",
      tokens: ["existing-token-1234"],
      port: 9931,
      env: {},
      installedAt: "2026-01-01T00:00:00.000Z",
    });
    mocks.writeDaemonConfig.mockResolvedValueOnce("/tmp/.summarize/daemon.json");

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/health"))
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      if (url.endsWith("/v1/ping"))
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      throw new Error(`Unexpected fetch: ${url}`);
    });

    const handled = await handleDaemonRequest({
      normalizedArgv: ["daemon", "install", "--token", "new-token-123456"],
      envForRun: { HOME: "/Users/peter" },
      fetchImpl: fetchMock as unknown as typeof fetch,
      stdout: new PassThrough(),
      stderr: new PassThrough(),
    });

    expect(handled).toBe(true);
    expect(mocks.writeDaemonConfig).toHaveBeenCalledWith({
      env: { HOME: "/Users/peter" },
      config: expect.objectContaining({
        token: "existing-token-1234",
        tokens: ["existing-token-1234", "new-token-123456"],
        port: 9931,
      }),
    });
  });

  it("starts the daemon and prints container autostart instructions for Windows containers", async () => {
    Object.defineProperty(process, "platform", { value: "win32" });
    mocks.isWindowsContainerEnvironment.mockReturnValue(true);
    mocks.readDaemonConfig.mockResolvedValueOnce(null);
    mocks.writeDaemonConfig.mockResolvedValueOnce(
      "C:\\Users\\ContainerAdministrator\\.summarize\\daemon.json",
    );

    const stdout = new PassThrough();
    let text = "";
    stdout.on("data", (chunk) => {
      text += chunk.toString();
    });

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/health"))
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      if (url.endsWith("/v1/ping"))
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      throw new Error(`Unexpected fetch: ${url}`);
    });

    const handled = await handleDaemonRequest({
      normalizedArgv: ["daemon", "install", "--token", "new-token-123456"],
      envForRun: {
        USERPROFILE: "C:\\Users\\ContainerAdministrator",
        CONTAINER_SANDBOX_MOUNT_POINT: "C:\\ContainerMappedDirectories",
      },
      fetchImpl: fetchMock as unknown as typeof fetch,
      stdout,
      stderr: new PassThrough(),
    });

    expect(handled).toBe(true);
    expect(mocks.installScheduledTask).not.toHaveBeenCalled();
    expect(mocks.spawn).toHaveBeenCalledTimes(1);
    expect(mocks.spawn).toHaveBeenCalledWith(
      process.execPath,
      expect.arrayContaining(["daemon", "run"]),
      expect.objectContaining({
        detached: true,
        windowsHide: true,
      }),
    );
    expect(text).toContain("Windows container detected: skipped Scheduled Task registration.");
    expect(text).toContain("Daemon autostart is not available in Windows container mode.");
    expect(text).toContain(
      "Run `summarize daemon install --token <TOKEN>` each time the container starts",
    );
    expect(text).toContain("requires a packaged Windows native-host executable");
    expect(text).toContain("OK: daemon is running in this container session and authenticated.");
  });
});
