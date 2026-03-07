import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  readDaemonConfig: vi.fn(),
  writeDaemonConfig: vi.fn(),
  runDaemonServer: vi.fn(),
}));

vi.mock("../src/daemon/config.js", () => ({
  readDaemonConfig: mocks.readDaemonConfig,
  writeDaemonConfig: mocks.writeDaemonConfig,
}));

vi.mock("../src/daemon/server.js", () => ({
  runDaemonServer: mocks.runDaemonServer,
}));

import { handleDaemonRequest } from "../src/daemon/cli.js";

describe("daemon cli", () => {
  const originalPath = process.env.PATH;
  const originalOpenAiKey = process.env.OPENAI_API_KEY;
  const originalHome = process.env.HOME;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.PATH = "/usr/bin:/bin";
    process.env.OPENAI_API_KEY = "from-process";
    process.env.HOME = "/tmp/original-home";
  });

  afterEach(() => {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    if (originalOpenAiKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalOpenAiKey;
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
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
      config: {
        token: "test-token",
        port: 8787,
        env: {
          PATH: "/opt/homebrew/bin:/usr/bin:/bin",
          OPENAI_API_KEY: "from-snapshot",
        },
      },
    });

    expect(process.env.PATH).toBe("/opt/homebrew/bin:/usr/bin:/bin");
    expect(process.env.OPENAI_API_KEY).toBe("from-snapshot");
    expect(process.env.HOME).toBe("/tmp/original-home");
  });
});
