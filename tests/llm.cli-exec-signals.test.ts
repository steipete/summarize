import { describe, expect, it, vi } from "vitest";
import { CliInterruptedError, execCliWithInput } from "../src/llm/cli-exec.js";
import type { ExecFileFn } from "../src/markitdown.js";

describe("execCliWithInput signals", () => {
  it("terminates the active child when the request aborts", async () => {
    const kill = vi.fn();
    let callback: Parameters<ExecFileFn>[3] | undefined;
    const controller = new AbortController();

    const execFileImpl: ExecFileFn = ((_cmd, _args, _options, cb) => {
      callback = cb;
      return {
        kill,
        stdin: {
          write: vi.fn(),
          end: vi.fn(),
        },
      } as unknown as ReturnType<ExecFileFn>;
    }) as ExecFileFn;

    const promise = execCliWithInput({
      execFileImpl,
      cmd: "slow-cli",
      args: [],
      input: "prompt",
      timeoutMs: 10_000,
      env: {},
      signal: controller.signal,
    });

    controller.abort();
    callback?.(Object.assign(new Error("terminated"), { signal: "SIGTERM", killed: true }), "", "");

    await expect(promise).rejects.toMatchObject({ name: "AbortError" });
    expect(kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("does not start a child for an already-aborted request", async () => {
    const execFileImpl = vi.fn() as unknown as ExecFileFn;
    const controller = new AbortController();
    controller.abort();

    await expect(
      execCliWithInput({
        execFileImpl,
        cmd: "slow-cli",
        args: [],
        input: "prompt",
        timeoutMs: 10_000,
        env: {},
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(execFileImpl).not.toHaveBeenCalled();
  });

  it("forwards SIGINT to the active child and rejects as an interrupt", async () => {
    const beforeSigint = process.listenerCount("SIGINT");
    const beforeSigterm = process.listenerCount("SIGTERM");
    const kill = vi.fn();
    let callback: Parameters<ExecFileFn>[3] | undefined;

    const execFileImpl: ExecFileFn = ((_cmd, _args, _options, cb) => {
      callback = cb;
      return {
        kill,
        stdin: {
          write: vi.fn(),
          end: vi.fn(),
        },
      } as unknown as ReturnType<ExecFileFn>;
    }) as ExecFileFn;

    const promise = execCliWithInput({
      execFileImpl,
      cmd: "slow-cli",
      args: [],
      input: "prompt",
      timeoutMs: 10_000,
      env: {},
    });

    process.emit("SIGINT");
    callback?.(Object.assign(new Error("interrupted"), { signal: "SIGINT", killed: true }), "", "");

    await expect(promise).rejects.toMatchObject({
      exitCode: 130,
      signal: "SIGINT",
      silent: true,
    });
    await expect(promise).rejects.toBeInstanceOf(CliInterruptedError);
    expect(kill).toHaveBeenCalledWith("SIGINT");
    expect(process.listenerCount("SIGINT")).toBe(beforeSigint);
    expect(process.listenerCount("SIGTERM")).toBe(beforeSigterm);
  });

  it("forwards SIGTERM with terminate exit semantics", async () => {
    const kill = vi.fn();
    let callback: Parameters<ExecFileFn>[3] | undefined;

    const execFileImpl: ExecFileFn = ((_cmd, _args, _options, cb) => {
      callback = cb;
      return {
        kill,
        stdin: {
          write: vi.fn(),
          end: vi.fn(),
        },
      } as unknown as ReturnType<ExecFileFn>;
    }) as ExecFileFn;

    const promise = execCliWithInput({
      execFileImpl,
      cmd: "slow-cli",
      args: [],
      input: "prompt",
      timeoutMs: 10_000,
      env: {},
    });

    process.emit("SIGTERM");
    callback?.(Object.assign(new Error("terminated"), { signal: "SIGTERM", killed: true }), "", "");

    await expect(promise).rejects.toMatchObject({
      exitCode: 143,
      signal: "SIGTERM",
      silent: true,
    });
    expect(kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("keeps the child-process cause when no redaction is requested", async () => {
    const execError = Object.assign(new Error("boom"), { code: 1 });
    const execFileImpl: ExecFileFn = ((_cmd, _args, _options, cb) => {
      cb?.(execError, "", "");
      return {
        stdin: {
          write: vi.fn(),
          end: vi.fn(),
        },
      } as unknown as ReturnType<ExecFileFn>;
    }) as ExecFileFn;

    const error = await execCliWithInput({
      execFileImpl,
      cmd: "cli",
      args: ["--flag"],
      input: "",
      timeoutMs: 10_000,
      env: {},
    }).catch((value: unknown) => value);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("boom");
    expect((error as Error & { cause?: unknown }).cause).toBe(execError);
  });

  it("uses a caller-provided redacted command for timeout errors", async () => {
    const secret = "raw secret";
    const execError = Object.assign(new Error("timed out"), {
      code: "ETIMEDOUT",
      cmd: `cli --secret ${secret}`,
    });
    const execFileImpl: ExecFileFn = ((_cmd, _args, _options, cb) => {
      cb?.(execError, "", `stderr ${secret}`);
      return {
        stdin: {
          write: vi.fn(),
          end: vi.fn(),
        },
      } as unknown as ReturnType<ExecFileFn>;
    }) as ExecFileFn;

    const error = await execCliWithInput({
      execFileImpl,
      cmd: "cli",
      args: ["--secret", secret],
      input: "",
      timeoutMs: 2_000,
      env: {},
      redactedCommand: "cli --secret [redacted]",
    }).catch((value: unknown) => value);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("cli --secret [redacted]");
    expect((error as Error).message).not.toContain("stderr");
    expect((error as Error).message).not.toContain(secret);
    expect((error as Error & { cause?: unknown }).cause).toBeUndefined();
  });

  it("omits the child-process cause when only a redacted command is provided", async () => {
    const execError = Object.assign(new Error("Command failed: cli --secret raw"), { code: 1 });
    const execFileImpl: ExecFileFn = ((_cmd, _args, _options, cb) => {
      cb?.(execError, "", "");
      return {
        stdin: {
          write: vi.fn(),
          end: vi.fn(),
        },
      } as unknown as ReturnType<ExecFileFn>;
    }) as ExecFileFn;

    const error = await execCliWithInput({
      execFileImpl,
      cmd: "cli",
      args: ["--secret", "raw"],
      input: "",
      timeoutMs: 2_000,
      env: {},
      redactedCommand: "cli --secret [redacted]",
    }).catch((value: unknown) => value);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("cli --secret [redacted]");
    expect((error as Error).message).not.toContain("raw");
    expect((error as Error & { cause?: unknown }).cause).toBeUndefined();
  });

  it("sanitizes synchronous launch errors for redacted commands", async () => {
    const secret = "raw secret";
    const execFileImpl: ExecFileFn = (() => {
      throw new TypeError(`The argument contains a null byte: ${secret}`);
    }) as ExecFileFn;

    const error = await execCliWithInput({
      execFileImpl,
      cmd: "cli",
      args: ["--secret", secret],
      input: "",
      timeoutMs: 2_000,
      env: {},
      redactedCommand: "cli --secret [redacted]",
    }).catch((value: unknown) => value);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("CLI command failed: cli --secret [redacted]");
    expect((error as Error).message).not.toContain(secret);
    expect((error as Error & { cause?: unknown }).cause).toBeUndefined();
  });
});
