import { once } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import type { ProcessRegistration } from "../packages/core/src/processes.js";
import {
  execFileTracked,
  runWithProcessContext,
  setProcessObserver,
  spawnTracked,
  terminateTrackedProcesses,
} from "../packages/core/src/processes.js";

const createObserver = (capture: {
  registrations: ProcessRegistration[];
  outputs: Array<{ stream: "stdout" | "stderr"; line: string }>;
}) => ({
  register: (info: ProcessRegistration) => {
    capture.registrations.push(info);
    return {
      id: info.command,
      setPid: () => {},
      appendOutput: (stream, line) => capture.outputs.push({ stream, line }),
      setProgress: () => {},
      setStatus: () => {},
      finish: () => {},
    };
  },
});

afterEach(() => {
  terminateTrackedProcesses("SIGKILL");
  setProcessObserver(null);
});

describe("process tracking", () => {
  it("propagates process context to registrations", async () => {
    const capture = { registrations: [] as ProcessRegistration[], outputs: [] };
    setProcessObserver(createObserver(capture));

    await runWithProcessContext({ runId: "run-123", source: "test" }, async () => {
      const { proc } = spawnTracked(process.execPath, ["-e", "process.exit(0)"], {
        stdio: "ignore",
        captureOutput: false,
      });
      await once(proc, "close");
    });

    expect(capture.registrations.length).toBe(1);
    expect(capture.registrations[0].runId).toBe("run-123");
    expect(capture.registrations[0].source).toBe("test");
  });

  it("captures execFile output", async () => {
    const capture = {
      registrations: [] as ProcessRegistration[],
      outputs: [] as Array<{ stream: "stdout" | "stderr"; line: string }>,
    };
    setProcessObserver(createObserver(capture));

    const proc = execFileTracked(process.execPath, ["-e", 'console.log("hello")']);
    await once(proc, "close");

    expect(capture.registrations.length).toBe(1);
    expect(capture.outputs.some((line) => line.line.includes("hello"))).toBe(true);
  });

  it("supports execFile callback signatures", async () => {
    const capture = {
      registrations: [] as ProcessRegistration[],
      outputs: [] as Array<{ stream: "stdout" | "stderr"; line: string }>,
    };
    setProcessObserver(createObserver(capture));

    await new Promise<void>((resolve, reject) => {
      const proc = execFileTracked(
        process.execPath,
        ["-e", 'console.log("callback")'],
        (error, stdout) => {
          if (error) {
            reject(error);
            return;
          }
          expect(stdout.toString()).toContain("callback");
          resolve();
        },
      );
      proc.on("error", reject);
    });

    await new Promise<void>((resolve, reject) => {
      const proc = execFileTracked(
        process.execPath,
        ["-e", 'console.log("options")'],
        { env: process.env },
        (error, stdout) => {
          if (error) {
            reject(error);
            return;
          }
          expect(stdout.toString()).toContain("options");
          resolve();
        },
      );
      proc.on("error", reject);
    });

    if (process.platform !== "win32") {
      await new Promise<void>((resolve, reject) => {
        const proc = execFileTracked("/usr/bin/true", (error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
        proc.on("error", reject);
      });
    }

    expect(capture.registrations.length).toBeGreaterThanOrEqual(2);
  });

  it("flushes final output and skips empty lines", async () => {
    const capture = {
      registrations: [] as ProcessRegistration[],
      outputs: [] as Array<{ stream: "stdout" | "stderr"; line: string }>,
    };
    setProcessObserver(createObserver(capture));

    const { proc } = spawnTracked(process.execPath, [
      "-e",
      'process.stdout.write("line-1\\n\\nline-2")',
    ]);
    await once(proc, "close");

    const lines = capture.outputs.map((entry) => entry.line);
    expect(lines).toContain("line-1");
    expect(lines).toContain("line-2");
    expect(lines).not.toContain("");
  });

  it("supports captureOutput=false", async () => {
    const capture = {
      registrations: [] as ProcessRegistration[],
      outputs: [] as Array<{ stream: "stdout" | "stderr"; line: string }>,
    };
    setProcessObserver(createObserver(capture));

    const { proc } = spawnTracked(process.execPath, ["-e", 'console.log("silent")'], {
      captureOutput: false,
    });
    await once(proc, "close");

    expect(capture.outputs.length).toBe(0);
  });

  it("terminates active tracked processes", async () => {
    const { proc } = spawnTracked(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
    });
    const closed = once(proc, "close");

    terminateTrackedProcesses("SIGTERM");

    const [, signal] = await closed;
    expect(signal).toBe("SIGTERM");
  });

  it.runIf(process.platform !== "win32")("terminates tracked process groups", async () => {
    const parentScript = [
      'const { spawn } = require("node:child_process");',
      "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
      "process.stdout.write(String(child.pid));",
      "setInterval(() => {}, 1000);",
    ].join("\n");
    const { proc } = spawnTracked(process.execPath, ["-e", parentScript], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    const [chunk] = await once(proc.stdout!, "data");
    const childPid = Number(String(chunk));
    const closed = once(proc, "close");

    terminateTrackedProcesses("SIGTERM");
    await closed;

    let childAlive = true;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      try {
        process.kill(childPid, 0);
        await new Promise((resolve) => setTimeout(resolve, 25));
      } catch {
        childAlive = false;
        break;
      }
    }
    expect(childAlive).toBe(false);
  });
});
