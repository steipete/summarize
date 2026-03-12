import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  execFile: vi.fn(),
}));

vi.mock("node:child_process", () => ({ execFile: mocks.execFile }));

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
      file: string,
      args: string[],
      _options: { encoding: string; windowsHide: boolean },
      callback: (error: NodeJS.ErrnoException | null, stdout: string, stderr: string) => void,
    ) => {
      if (file === "taskkill") {
        callback(null, "SUCCESS: The process was terminated.", "");
        return {} as never;
      }
      if (file === "schtasks" && args[0] === "/Query") {
        callback(null, "", "");
        return {} as never;
      }
      callback(null, "", "");
      return {} as never;
    },
  );
}

describe("daemon/schtasks install", () => {
  beforeEach(() => {
    mocks.execFile.mockReset();
  });

  it("writes a hidden launcher that tracks the daemon pid", async () => {
    mockExecFileSuccess();
    const home = mkdtempSync(path.join(tmpdir(), "summarize-schtasks-"));
    const out = collectStream();

    const { scriptPath } = await installScheduledTask({
      env: { HOME: home },
      stdout: out.stream,
      programArguments: ["node", "dist/cli.js", "daemon", "run"],
    });

    const launcherPath = path.join(home, ".summarize", "daemon-run.vbs");
    const pidPath = path.join(home, ".summarize", "daemon.pid");
    const launcher = readFileSync(launcherPath, "utf8");
    const script = readFileSync(scriptPath, "utf8");

    expect(script).toContain("node dist/cli.js daemon run");
    expect(launcher).toContain("processStartup.ShowWindow = 0");
    expect(launcher).toContain('Win32_Process").Create');
    expect(launcher).toContain(`pidPath = "${pidPath.replace(/\\/g, "\\\\")}"`);
    expect(launcher).toContain("fso.DeleteFile pidPath, True");
    expect(out.getText()).toContain("Installed Scheduled Task");

    const createCall = mocks.execFile.mock.calls.find(
      (call) => call[0] === "schtasks" && (call[1] as string[])[0] === "/Create",
    );
    expect(createCall).toBeTruthy();
    expect(createCall?.[1]).toContain(path.join(home, ".summarize", "daemon-run.vbs"));
  });
});

describe("daemon/schtasks lifecycle", () => {
  beforeEach(() => {
    mocks.execFile.mockReset();
  });

  it("kills the tracked daemon pid before rerunning the task", async () => {
    mockExecFileSuccess();
    const home = mkdtempSync(path.join(tmpdir(), "summarize-schtasks-"));
    const pidPath = path.join(home, ".summarize", "daemon.pid");
    mkdirSync(path.dirname(pidPath), { recursive: true });
    writeFileSync(pidPath, "4242", "utf8");
    const out = collectStream();

    await restartScheduledTask({
      env: { HOME: home },
      stdout: out.stream,
    });

    const commands = mocks.execFile.mock.calls.map(
      ([file, args]) => `${file} ${(args as string[]).join(" ")}`,
    );
    const taskkillCommand = "taskkill /PID 4242 /T /F";
    const runCommand = `schtasks /Run /TN ${DAEMON_WINDOWS_TASK_NAME}`;
    expect(commands).toContain(taskkillCommand);
    expect(commands).toContain(runCommand);
    expect(commands.indexOf(taskkillCommand)).toBeLessThan(commands.indexOf(runCommand));
    expect(out.getText()).toContain("Restarted Scheduled Task");
  });

  it("removes the tracked pid and launcher on uninstall", async () => {
    mockExecFileSuccess();
    const home = mkdtempSync(path.join(tmpdir(), "summarize-schtasks-"));
    const summarizeDir = path.join(home, ".summarize");
    mkdirSync(summarizeDir, { recursive: true });
    const pidPath = path.join(summarizeDir, "daemon.pid");
    const launcherPath = path.join(summarizeDir, "daemon-run.vbs");
    const scriptPath = path.join(summarizeDir, "daemon.cmd");
    writeFileSync(pidPath, "5252", "utf8");
    writeFileSync(launcherPath, "launcher", "utf8");
    writeFileSync(scriptPath, "script", "utf8");
    const out = collectStream();

    await uninstallScheduledTask({
      env: { HOME: home },
      stdout: out.stream,
    });

    const commands = mocks.execFile.mock.calls.map(
      ([file, args]) => `${file} ${(args as string[]).join(" ")}`,
    );
    expect(commands).toContain("taskkill /PID 5252 /T /F");
    expect(commands).toContain(`schtasks /Delete /F /TN ${DAEMON_WINDOWS_TASK_NAME}`);
    expect(out.getText()).toContain("Removed task launcher");
    expect(existsSync(pidPath)).toBe(false);
    expect(existsSync(launcherPath)).toBe(false);
    expect(existsSync(scriptPath)).toBe(false);
  });
});
