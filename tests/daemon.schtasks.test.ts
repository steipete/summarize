import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  execFile: vi.fn(),
}));

vi.mock("node:child_process", () => ({ execFile: mocks.execFile }));

const originalFetch = globalThis.fetch;
function setFetchPid(pid: number | null) {
  globalThis.fetch = (async () => {
    if (pid === null) throw new Error("daemon down");
    return new Response(JSON.stringify({ ok: true, pid }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
}
function clearFetch() {
  globalThis.fetch = originalFetch;
}

function writeDaemonConfig(home: string, port = 8787) {
  const dir = path.join(home, ".summarize");
  mkdirSync(dir, { recursive: true });
  const token = "0123456789abcdef0123456789abcdef";
  writeFileSync(
    path.join(dir, "daemon.json"),
    JSON.stringify({ version: 2, token, tokens: [token], port, env: {} }),
    "utf8",
  );
}

import { DAEMON_WINDOWS_TASK_NAME } from "../src/daemon/constants.js";
import {
  installScheduledTask,
  restartScheduledTask,
  uninstallScheduledTask,
} from "../src/daemon/schtasks.js";

function collectStream(): { stream: Writable; getText: () => string } {
  let text = "";
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      text += chunk.toString();
      callback();
    },
  });
  return { stream, getText: () => text };
}

function mockExecFileSuccess() {
  mocks.execFile.mockImplementation(
    (
      _file: string,
      _args: string[],
      _options: { encoding: string; windowsHide: boolean },
      callback: (error: NodeJS.ErrnoException | null, stdout: string, stderr: string) => void,
    ) => {
      callback(null, "", "");
      return {} as never;
    },
  );
}

describe("daemon/schtasks install", () => {
  beforeEach(() => {
    mocks.execFile.mockReset();
  });

  it("registers a hidden /XML task that launches via wscript with battery flags off", async () => {
    mockExecFileSuccess();
    const home = mkdtempSync(path.join(tmpdir(), "summarize-schtasks-"));
    const out = collectStream();

    const { scriptPath } = await installScheduledTask({
      env: { HOME: home, USERNAME: "testuser", USERDOMAIN: "TESTHOST" },
      stdout: out.stream,
      programArguments: ["node", "dist/cli.js", "daemon", "run"],
    });

    const script = readFileSync(scriptPath, "utf8");
    expect(script).toContain("node dist/cli.js daemon run");
    expect(out.getText()).toContain("Installed Scheduled Task");

    const launcherPath = path.join(home, ".summarize", "daemon-launch.vbs");
    const launcher = readFileSync(launcherPath, "utf8");
    expect(launcher).toContain('Set sh = CreateObject("WScript.Shell")');
    expect(launcher).toContain('sh.Run "node dist/cli.js daemon run", 0, False');

    const xmlPath = path.join(home, ".summarize", "daemon-task.xml");
    const xml = readFileSync(xmlPath, "utf8");
    expect(xml).toContain('<?xml version="1.0" encoding="UTF-8"?>');
    expect(xml).toContain("<DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>");
    expect(xml).toContain("<StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>");
    expect(xml).toContain("<Hidden>true</Hidden>");
    expect(xml).toContain("<LogonTrigger>");
    expect(xml).toContain("<UserId>TESTHOST\\testuser</UserId>");
    expect(xml).toContain("<LogonType>InteractiveToken</LogonType>");
    expect(xml).toContain("<RunLevel>LeastPrivilege</RunLevel>");
    expect(xml).toContain("<Command>wscript.exe</Command>");
    expect(xml).toContain(`<Arguments>//B //Nologo &quot;${launcherPath}&quot;</Arguments>`);

    const createCall = mocks.execFile.mock.calls.find(
      (call) => call[0] === "schtasks" && (call[1] as string[])[0] === "/Create",
    );
    expect(createCall).toBeTruthy();
    const createArgs = createCall?.[1] as string[];
    const xmlIndex = createArgs.indexOf("/XML");
    expect(xmlIndex).toBeGreaterThanOrEqual(0);
    expect(createArgs[xmlIndex + 1]).toBe(xmlPath);
    expect(createArgs).not.toContain("/TR");
  });

  it("falls back to COMPUTERNAME when USERDOMAIN is missing", async () => {
    mockExecFileSuccess();
    const home = mkdtempSync(path.join(tmpdir(), "summarize-schtasks-"));
    const out = collectStream();

    await installScheduledTask({
      env: { HOME: home, USERNAME: "testuser", COMPUTERNAME: "FALLBACK" },
      stdout: out.stream,
      programArguments: ["node", "dist/cli.js", "daemon", "run"],
    });

    const xml = readFileSync(path.join(home, ".summarize", "daemon-task.xml"), "utf8");
    expect(xml).toContain("<UserId>FALLBACK\\testuser</UserId>");
  });

  it("cleans up legacy launcher and pid artifacts on install", async () => {
    mockExecFileSuccess();
    const home = mkdtempSync(path.join(tmpdir(), "summarize-schtasks-"));
    const summarizeDir = path.join(home, ".summarize");
    mkdirSync(summarizeDir, { recursive: true });
    const legacyLauncher = path.join(summarizeDir, "daemon-run.vbs");
    const legacyPid = path.join(summarizeDir, "daemon.pid");
    writeFileSync(legacyLauncher, "old", "utf8");
    writeFileSync(legacyPid, "1234", "utf8");
    const out = collectStream();

    await installScheduledTask({
      env: { HOME: home, USERNAME: "testuser", USERDOMAIN: "TESTHOST" },
      stdout: out.stream,
      programArguments: ["node", "dist/cli.js", "daemon", "run"],
    });

    expect(existsSync(legacyLauncher)).toBe(false);
    expect(existsSync(legacyPid)).toBe(false);
  });

  it("hints at elevation when schtasks /Create returns access denied", async () => {
    mocks.execFile.mockImplementation(
      (
        file: string,
        args: string[],
        _options: { encoding: string; windowsHide: boolean },
        callback: (error: unknown, stdout: string, stderr: string) => void,
      ) => {
        if (file === "schtasks" && args[0] === "/Create") {
          const error = Object.assign(new Error("schtasks failed"), {
            code: 1,
            stdout: "",
            stderr: "ERROR: Access is denied.",
          });
          callback(error, "", "ERROR: Access is denied.");
          return {} as never;
        }
        callback(null, "", "");
        return {} as never;
      },
    );
    const home = mkdtempSync(path.join(tmpdir(), "summarize-schtasks-"));
    const out = collectStream();

    await expect(
      installScheduledTask({
        env: { HOME: home, USERNAME: "testuser", USERDOMAIN: "TESTHOST" },
        stdout: out.stream,
        programArguments: ["node", "dist/cli.js", "daemon", "run"],
      }),
    ).rejects.toThrow(/elevated/);
  });

  it("reports schtasks /Run failures after task creation", async () => {
    mocks.execFile.mockImplementation(
      (
        file: string,
        args: string[],
        _options: { encoding: string; windowsHide: boolean },
        callback: (error: unknown, stdout: string, stderr: string) => void,
      ) => {
        if (file === "schtasks" && args[0] === "/Run") {
          const error = Object.assign(new Error("schtasks run failed"), {
            code: 1,
            stdout: "",
            stderr: "ERROR: The task could not be started.",
          });
          callback(error, "", "ERROR: The task could not be started.");
          return {} as never;
        }
        callback(null, "", "");
        return {} as never;
      },
    );
    const home = mkdtempSync(path.join(tmpdir(), "summarize-schtasks-"));
    const out = collectStream();

    await expect(
      installScheduledTask({
        env: { HOME: home, USERNAME: "testuser", USERDOMAIN: "TESTHOST" },
        stdout: out.stream,
        programArguments: ["node", "dist/cli.js", "daemon", "run"],
      }),
    ).rejects.toThrow(/task could not be started/);
  });
});

describe("daemon/schtasks lifecycle", () => {
  beforeEach(() => {
    mocks.execFile.mockReset();
  });
  afterEach(() => {
    clearFetch();
  });

  it("kills the live daemon pid before rerunning the task", async () => {
    mockExecFileSuccess();
    setFetchPid(4242);
    const home = mkdtempSync(path.join(tmpdir(), "summarize-schtasks-"));
    writeDaemonConfig(home);
    const out = collectStream();

    await restartScheduledTask({
      env: { HOME: home },
      stdout: out.stream,
    });

    const commands = mocks.execFile.mock.calls.map(
      ([file, args]) => `${file} ${(args as string[]).join(" ")}`,
    );
    const taskkillCommand = "taskkill /PID 4242 /T /F";
    const endCommand = `schtasks /End /TN ${DAEMON_WINDOWS_TASK_NAME}`;
    const runCommand = `schtasks /Run /TN ${DAEMON_WINDOWS_TASK_NAME}`;
    expect(commands).toContain(taskkillCommand);
    expect(commands).toContain(endCommand);
    expect(commands).toContain(runCommand);
    expect(commands.indexOf(taskkillCommand)).toBeLessThan(commands.indexOf(endCommand));
    expect(commands.indexOf(endCommand)).toBeLessThan(commands.indexOf(runCommand));
    expect(out.getText()).toContain("Restarted Scheduled Task");
  });

  it("skips taskkill on restart when the daemon is already down", async () => {
    mockExecFileSuccess();
    setFetchPid(null);
    const home = mkdtempSync(path.join(tmpdir(), "summarize-schtasks-"));
    writeDaemonConfig(home);
    const out = collectStream();

    await restartScheduledTask({
      env: { HOME: home },
      stdout: out.stream,
    });

    const commands = mocks.execFile.mock.calls.map(
      ([file, args]) => `${file} ${(args as string[]).join(" ")}`,
    );
    expect(commands.some((c) => c.startsWith("taskkill"))).toBe(false);
    expect(commands).toContain(`schtasks /Run /TN ${DAEMON_WINDOWS_TASK_NAME}`);
  });

  it("removes the task script, launcher, xml definition, and any legacy artifacts on uninstall", async () => {
    mockExecFileSuccess();
    setFetchPid(5252);
    const home = mkdtempSync(path.join(tmpdir(), "summarize-schtasks-"));
    writeDaemonConfig(home);
    const summarizeDir = path.join(home, ".summarize");
    const scriptPath = path.join(summarizeDir, "daemon.cmd");
    const launcherPath = path.join(summarizeDir, "daemon-launch.vbs");
    const xmlPath = path.join(summarizeDir, "daemon-task.xml");
    const legacyLauncher = path.join(summarizeDir, "daemon-run.vbs");
    const legacyPid = path.join(summarizeDir, "daemon.pid");
    writeFileSync(scriptPath, "script", "utf8");
    writeFileSync(launcherPath, "launcher", "utf8");
    writeFileSync(xmlPath, "xml", "utf8");
    writeFileSync(legacyLauncher, "old", "utf8");
    writeFileSync(legacyPid, "5252", "utf8");
    const out = collectStream();

    await uninstallScheduledTask({
      env: { HOME: home },
      stdout: out.stream,
    });

    const commands = mocks.execFile.mock.calls.map(
      ([file, args]) => `${file} ${(args as string[]).join(" ")}`,
    );
    expect(commands).toContain("taskkill /PID 5252 /T /F");
    expect(commands).toContain(`schtasks /End /TN ${DAEMON_WINDOWS_TASK_NAME}`);
    expect(commands).toContain(`schtasks /Delete /F /TN ${DAEMON_WINDOWS_TASK_NAME}`);
    expect(out.getText()).toContain("Removed task script");
    expect(existsSync(scriptPath)).toBe(false);
    expect(existsSync(launcherPath)).toBe(false);
    expect(existsSync(xmlPath)).toBe(false);
    expect(existsSync(legacyLauncher)).toBe(false);
    expect(existsSync(legacyPid)).toBe(false);
  });
});
