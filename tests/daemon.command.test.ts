import { describe, expect, it } from "vitest";
import { execDaemonCommand } from "../src/daemon/command.js";

describe("daemon command execution", () => {
  it.each([{}, { windowsHide: true }])("captures successful output with %j", async (options) => {
    const result = await execDaemonCommand(
      process.execPath,
      ["-e", 'process.stdout.write("output"); process.stderr.write("detail");'],
      options,
    );
    expect(result).toEqual({ stdout: "output", stderr: "detail", code: 0 });
  });

  it("preserves output and numeric exit codes on failure", async () => {
    const result = await execDaemonCommand(process.execPath, [
      "-e",
      'process.stdout.write("partial"); process.stderr.write("failed"); process.exit(7);',
    ]);
    expect(result).toEqual({ stdout: "partial", stderr: "failed", code: 7 });
  });

  it("preserves empty stderr from asynchronous spawn failures", async () => {
    const result = await execDaemonCommand(join(dirname(process.execPath), randomUUID()), []);
    expect(result).toEqual({ stdout: "", stderr: "", code: 1 });
  });

  it("uses the diagnostic for synchronous errors without captured stderr", async () => {
    const result = await execDaemonCommand("", []);
    expect(result).toEqual({ stdout: "", stderr: expect.stringContaining("file"), code: 1 });
  });
});
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
