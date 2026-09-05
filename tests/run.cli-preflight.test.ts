import { describe, expect, it, vi } from "vitest";
import { captureStream as collectStream } from "./helpers/streams.js";

const mocks = vi.hoisted(() => ({
  refreshFree: vi.fn(async () => {}),
  handleDaemonRequest: vi.fn(async () => false),
  attachRichHelp: vi.fn(),
  buildDaemonHelp: vi.fn(() => "DAEMON_HELP"),
  buildRefreshFreeHelp: vi.fn(() => "REFRESH_FREE_HELP"),
  buildStatusHelp: vi.fn(() => "STATUS_HELP"),
  buildProgram: vi.fn(() => ({
    configureOutput: vi.fn(),
    outputHelp: vi.fn(),
  })),
}));

vi.mock("../src/refresh-free.js", () => ({
  refreshFree: mocks.refreshFree,
}));

vi.mock("../src/daemon/cli.js", () => ({
  handleDaemonRequest: mocks.handleDaemonRequest,
}));

vi.mock("../src/run/help.js", () => ({
  attachRichHelp: mocks.attachRichHelp,
  buildDaemonHelp: mocks.buildDaemonHelp,
  buildProgram: mocks.buildProgram,
  buildRefreshFreeHelp: mocks.buildRefreshFreeHelp,
  buildStatusHelp: mocks.buildStatusHelp,
}));

import {
  handleDaemonCliRequest,
  handleHelpRequest,
  handleRefreshFreeRequest,
} from "../src/run/cli-preflight.js";

describe("run/cli-preflight", () => {
  it("handleHelpRequest: returns false when not help", () => {
    const stdout = collectStream();
    const stderr = collectStream();
    expect(
      handleHelpRequest({
        normalizedArgv: ["summarize", "--help"],
        envForRun: {},
        stdout: stdout.stream,
        stderr: stderr.stream,
      }),
    ).toBe(false);
  });

  it("handleHelpRequest: prints refresh-free help", () => {
    const stdout = collectStream();
    const stderr = collectStream();
    expect(
      handleHelpRequest({
        normalizedArgv: ["help", "refresh-free"],
        envForRun: {},
        stdout: stdout.stream,
        stderr: stderr.stream,
      }),
    ).toBe(true);
    expect(stdout.getText()).toContain("REFRESH_FREE_HELP");
    expect(stderr.getText()).toBe("");
  });

  it("handleHelpRequest: prints daemon help", () => {
    const stdout = collectStream();
    const stderr = collectStream();
    expect(
      handleHelpRequest({
        normalizedArgv: ["help", "daemon"],
        envForRun: {},
        stdout: stdout.stream,
        stderr: stderr.stream,
      }),
    ).toBe(true);
    expect(stdout.getText()).toContain("DAEMON_HELP");
    expect(stderr.getText()).toBe("");
  });

  it("handleHelpRequest: prints status help", () => {
    const stdout = collectStream();
    const stderr = collectStream();
    expect(
      handleHelpRequest({
        normalizedArgv: ["help", "status"],
        envForRun: {},
        stdout: stdout.stream,
        stderr: stderr.stream,
      }),
    ).toBe(true);
    expect(stdout.getText()).toContain("STATUS_HELP");
    expect(stderr.getText()).toBe("");
  });

  it("handleHelpRequest: falls back to commander help", () => {
    mocks.attachRichHelp.mockClear();
    mocks.buildProgram.mockClear();

    const stdout = collectStream();
    const stderr = collectStream();
    expect(
      handleHelpRequest({
        normalizedArgv: ["help"],
        envForRun: { FOO: "bar" },
        stdout: stdout.stream,
        stderr: stderr.stream,
      }),
    ).toBe(true);

    expect(mocks.buildProgram).toHaveBeenCalledTimes(1);
    expect(mocks.attachRichHelp).toHaveBeenCalledTimes(1);
  });

  it("handleRefreshFreeRequest: returns false when not refresh-free", async () => {
    const stdout = collectStream();
    const stderr = collectStream();
    await expect(
      handleRefreshFreeRequest({
        normalizedArgv: ["help"],
        envForRun: {},
        fetchImpl: fetch,
        stdout: stdout.stream,
        stderr: stderr.stream,
      }),
    ).resolves.toBe(false);
  });

  it("handleRefreshFreeRequest: prints help", async () => {
    const stdout = collectStream();
    const stderr = collectStream();
    await expect(
      handleRefreshFreeRequest({
        normalizedArgv: ["refresh-free", "--help"],
        envForRun: {},
        fetchImpl: fetch,
        stdout: stdout.stream,
        stderr: stderr.stream,
      }),
    ).resolves.toBe(true);
    expect(stdout.getText()).toContain("REFRESH_FREE_HELP");
    expect(stderr.getText()).toBe("");
  });

  it("handleRefreshFreeRequest: validates numeric args", async () => {
    const stdout = collectStream();
    const stderr = collectStream();
    await expect(
      handleRefreshFreeRequest({
        normalizedArgv: ["refresh-free", "--runs=-1"],
        envForRun: {},
        fetchImpl: fetch,
        stdout: stdout.stream,
        stderr: stderr.stream,
      }),
    ).rejects.toThrow("--runs must be >= 0");
  });

  it("handleRefreshFreeRequest: calls refreshFree with parsed options", async () => {
    mocks.refreshFree.mockClear();

    const stdout = collectStream();
    const stderr = collectStream();
    await expect(
      handleRefreshFreeRequest({
        normalizedArgv: [
          "refresh-free",
          "--runs=3",
          "--smart",
          "2",
          "--min-params",
          "27b",
          "--max-age-days=90",
          "--set-default",
          "--verbose",
        ],
        envForRun: { OPENROUTER_API_KEY: "x" },
        fetchImpl: fetch,
        stdout: stdout.stream,
        stderr: stderr.stream,
      }),
    ).resolves.toBe(true);

    expect(mocks.refreshFree).toHaveBeenCalledTimes(1);
    expect(mocks.refreshFree.mock.calls[0]?.[0]).toMatchObject({
      verbose: true,
      options: {
        runs: 3,
        smart: 2,
        minParamB: 27,
        maxAgeDays: 90,
        setDefault: true,
        maxCandidates: 10,
        concurrency: 4,
        timeoutMs: 10_000,
      },
    });
  });

  it("handleDaemonCliRequest: forwards to daemon handler", async () => {
    mocks.handleDaemonRequest.mockResolvedValueOnce(true);
    const stdout = collectStream();
    const stderr = collectStream();
    await expect(
      handleDaemonCliRequest({
        normalizedArgv: ["daemon", "status"],
        envForRun: {},
        fetchImpl: fetch,
        stdout: stdout.stream,
        stderr: stderr.stream,
      }),
    ).resolves.toBe(true);
  });
});
