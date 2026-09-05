import { afterEach, describe, expect, it, vi } from "vitest";
import {
  setProcessObserver,
  terminateTrackedProcesses,
  type ProcessHandle,
} from "../src/processes.js";
import {
  runProcess,
  runProcessCapture,
  runProcessCaptureBuffer,
  runWithConcurrency,
} from "../src/slides/process.js";

afterEach(() => {
  terminateTrackedProcesses("SIGKILL");
  setProcessObserver(null);
});

function processOptions(source: string) {
  return {
    command: { command: process.execPath, argsPrefix: ["-e", source], source: "wasm" as const },
    args: [],
    timeoutMs: 5_000,
    errorLabel: "test tool",
  };
}

function observeOutput() {
  const handle: ProcessHandle = {
    id: "test-process",
    setPid: vi.fn(),
    appendOutput: vi.fn(),
    setProgress: vi.fn(),
    setStatus: vi.fn(),
    finish: vi.fn(),
  };
  setProcessObserver({ register: () => handle });
  return handle;
}

describe("media subprocess lifecycle", () => {
  it.each([false, true])(
    "preserves line callbacks and stdout fallback: %s",
    async (separateStdout) => {
      const handle = observeOutput();
      const stderr = vi.fn();
      const stdout = vi.fn();
      await runProcess({
        ...processOptions(
          'process.stdout.write("first\\r\\n\\n  tail  "); process.stderr.write("warning\\n\\n  last  ");',
        ),
        onStderrLine: stderr,
        onStdoutLine: separateStdout ? stdout : undefined,
      });
      const stdoutCallback = separateStdout ? stdout : stderr;
      expect(stdoutCallback).toHaveBeenCalledWith("first", handle);
      expect(stdoutCallback).toHaveBeenCalledWith("tail", handle);
      expect(stderr).toHaveBeenCalledWith("warning", handle);
      expect(stderr).toHaveBeenCalledWith("last", handle);
      expect(stderr).toHaveBeenCalledTimes(separateStdout ? 2 : 4);
      expect(handle.appendOutput).toHaveBeenCalledTimes(4);
    },
  );

  it("captures UTF-8 across chunks and tracks complete and final partial lines", async () => {
    const handle = observeOutput();
    const output = await runProcessCapture(
      processOptions(
        "process.stdout.write(Buffer.from([0xe2])); setTimeout(() => process.stdout.write(Buffer.from([0x82, 0xac, 10, 32, 120, 32])), 20);",
      ),
    );
    expect(output).toBe("€\n x ");
    expect(handle.appendOutput).toHaveBeenCalledWith("stdout", "€");
    expect(handle.appendOutput).toHaveBeenCalledWith("stdout", "x");
  });

  it("preserves arbitrary bytes without logging binary stdout", async () => {
    const handle = observeOutput();
    const output = await runProcessCaptureBuffer(
      processOptions(
        'process.stdout.write(Buffer.from([0, 255, 13, 10, 128])); process.stderr.write("  warning  ");',
      ),
    );
    expect(output).toEqual(Buffer.from([0, 255, 13, 10, 128]));
    expect(handle.appendOutput).toHaveBeenCalledExactlyOnceWith("stderr", "warning");
  });

  it("drains ignored stdout rather than blocking the child on a full pipe", async () => {
    await expect(
      runProcess(
        processOptions(
          "process.stdout.write(Buffer.alloc(4 * 1024 * 1024), () => process.exit(0));",
        ),
      ),
    ).resolves.toBeUndefined();
  });

  describe.each([runProcess, runProcessCapture, runProcessCaptureBuffer])("%s", (run) => {
    it("reports nonzero exits with the final stderr line", async () => {
      await expect(
        run(processOptions('process.stderr.write("  failed  "); process.exitCode = 7;')),
      ).rejects.toThrow("test tool exited with code 7: failed");
    });
    it("rejects launch failures", async () => {
      await expect(
        run({ ...processOptions(""), command: "summarize-missing-test-command" }),
      ).rejects.toThrow(/ENOENT/);
    });
    it("kills a timed-out child", async () => {
      await expect(
        run({ ...processOptions("setInterval(() => {}, 1000)"), timeoutMs: 25 }),
      ).rejects.toThrow("test tool timed out");
    });
  });
});

describe("slides process helpers", () => {
  it("returns early for empty task lists", async () => {
    await expect(runWithConcurrency([], 4)).resolves.toEqual([]);
  });

  it("preserves order, clamps workers, and reports progress", async () => {
    const progress = vi.fn();
    const results = await runWithConcurrency(
      [async () => "a", async () => "b", async () => "c"],
      99,
      progress,
    );

    expect(results).toEqual(["a", "b", "c"]);
    expect(progress).toHaveBeenCalledTimes(3);
    expect(progress).toHaveBeenLastCalledWith(3, 3);
  });
});
