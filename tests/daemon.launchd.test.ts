import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { captureStream as collectStream } from "./helpers/streams.js";

const mocks = vi.hoisted(() => ({
  execFile: vi.fn(),
}));

vi.mock("node:child_process", () => ({ execFile: mocks.execFile }));

import { DAEMON_LAUNCH_AGENT_LABEL } from "../src/daemon/constants.js";
import {
  installLaunchAgent,
  resolveLaunchctlDomains,
  resolveLaunchctlTargetUid,
} from "../src/daemon/launchd.js";

describe("daemon/launchd domain resolution", () => {
  it("resolves target uid with sudo fallback for root", () => {
    expect(resolveLaunchctlTargetUid({ uid: 501 })).toBe(501);
    expect(resolveLaunchctlTargetUid({ uid: 0, sudoUid: " 502 " })).toBe(502);
    expect(resolveLaunchctlTargetUid({ uid: 0, sudoUid: "invalid" })).toBe(0);
    expect(resolveLaunchctlTargetUid({ uid: 0, sudoUid: "" })).toBe(0);
  });

  it("builds launchctl domain candidates", () => {
    expect(resolveLaunchctlDomains({ uid: 501 })).toEqual(["gui/501", "user/501"]);
  });
});

describe("daemon/launchd install", () => {
  beforeEach(() => {
    mocks.execFile.mockReset();
  });

  it("falls back to user domain when gui bootstrap fails", async () => {
    let uidSpy: ReturnType<typeof vi.spyOn> | null = null;
    if (typeof process.getuid === "function") {
      uidSpy = vi.spyOn(process, "getuid").mockReturnValue(501);
    }

    try {
      mocks.execFile.mockImplementation(
        (
          _file: string,
          args: string[],
          _options: { encoding: string },
          callback: (error: NodeJS.ErrnoException | null, stdout: string, stderr: string) => void,
        ) => {
          if (args[0] === "bootstrap" && args[1] === "gui/501") {
            const error = Object.assign(new Error("Bootstrap failed: 5: Input/output error"), {
              code: 5,
              stdout: "",
              stderr: "Bootstrap failed: 5: Input/output error",
            }) as NodeJS.ErrnoException;
            callback(error, "", "");
            return {} as never;
          }
          callback(null, "", "");
          return {} as never;
        },
      );

      const home = mkdtempSync(path.join(tmpdir(), "summarize-launchd-"));
      const out = collectStream();

      const { plistPath } = await installLaunchAgent({
        env: { HOME: home },
        stdout: out.stream,
        programArguments: ["/usr/bin/node", "/tmp/cli.js", "daemon", "run"],
      });

      const commands = mocks.execFile.mock.calls.map((call) => (call[1] as string[]).join(" "));
      expect(commands).toContain(`bootstrap gui/501 ${plistPath}`);
      expect(commands).toContain(`bootstrap user/501 ${plistPath}`);
      expect(commands).toContain(`enable user/501/${DAEMON_LAUNCH_AGENT_LABEL}`);
      expect(commands).toContain(`kickstart -k user/501/${DAEMON_LAUNCH_AGENT_LABEL}`);
      expect(out.getText()).toContain("Launch domain: user/501");
    } finally {
      uidSpy?.mockRestore();
    }
  });
});
