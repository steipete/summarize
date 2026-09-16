import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { serviceCommandError } from "../src/daemon/command.js";
import { restartLaunchAgent } from "../src/daemon/launchd.js";
import { restartScheduledTask } from "../src/daemon/schtasks.js";
import { restartSystemdService } from "../src/daemon/systemd.js";
import { CliError } from "../src/locale.js";
import { captureStream } from "./helpers/streams.js";

const command = vi.hoisted(() => vi.fn());
vi.mock("../src/daemon/command.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/daemon/command.js")>()),
  execDaemonCommand: command,
}));

let home: string;
beforeEach(() => {
  command.mockReset();
  home = mkdtempSync(path.join(tmpdir(), "summarize-service-locale-"));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

describe("localized daemon service failures", () => {
  it.each([
    ["systemctl", "restart", restartSystemdService],
    ["launchctl", "kickstart", restartLaunchAgent],
    ["schtasks", "/Run", restartScheduledTask],
  ] as const)(
    "localizes %s failure text while retaining native output",
    async (binary, action, restart) => {
      const detail = "Native diagnostic: Copy failed /fixture/path";
      command.mockImplementation(async (_file, args: string[]) =>
        args.includes(action)
          ? { code: 1, stderr: detail, stdout: "" }
          : { code: 0, stderr: "", stdout: "" },
      );
      const error = await restart({
        env: { HOME: home, USERPROFILE: home },
        stdout: captureStream().stream,
      }).catch((error) => error);
      expect(error).toBeInstanceOf(CliError);
      expect(error.message).toContain("failed:");
      expect(error.format("tr")).toContain("başarısız:");
      expect(error.format("tr")).toContain(detail);
      expect(command).toHaveBeenCalledWith(
        binary,
        expect.arrayContaining([action]),
        ...(binary === "schtasks" ? [{ windowsHide: true }] : []),
      );
    },
  );

  it("localizes systemd availability and empty-command diagnostics", async () => {
    command.mockResolvedValue({ code: 1, stderr: "systemctl not found", stdout: "" });
    const error = await restartSystemdService({ stdout: captureStream().stream }).catch(
      (error) => error,
    );
    expect(error.format("tr")).toBe(
      "systemctl kullanılamıyor; Linux üzerinde systemd kullanıcı hizmetleri gereklidir.",
    );
    expect(serviceCommandError("systemctl --user", "", "unavailable").format("tr")).toBe(
      "systemctl --user kullanılamıyor: bilinmeyen hata",
    );
  });

  it("localizes the Windows administrator hint without changing its command", () => {
    const error = serviceCommandError("schtasks create", "Access is denied", "failed", true);
    expect(error.format("tr")).toContain("Access is denied");
    expect(error.format("tr")).toContain("yönetici olarak");
    expect(error.format("tr")).toContain("`summarize daemon install`");
  });
});
