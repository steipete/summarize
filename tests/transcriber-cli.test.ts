import { Writable } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  access: vi.fn(),
  spawn: vi.fn(),
}));

vi.mock("node:fs/promises", () => ({ access: mocks.access }));
vi.mock("node:child_process", () => ({ spawn: mocks.spawn }));

import { handleTranscriberCliRequest } from "../src/run/transcriber-cli.js";

const AUTO_ORDER =
  "Groq -> ONNX (selected/configured parakeet or canary) -> whisper.cpp -> AssemblyAI -> Gemini -> OpenAI -> FAL -> Deepgram";

const collectStream = () => {
  let text = "";
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      text += chunk.toString();
      callback();
    },
  });
  return { stream, getText: () => text };
};

const makeSpawnResult = (kind: "error" | "close", code = 0) => {
  mocks.spawn.mockImplementation(() => ({
    on(event: "error" | "close", cb: (arg?: number | Error) => void) {
      if (event === kind) {
        cb(kind === "error" ? new Error("nope") : code);
      }
      return this;
    },
  }));
};

describe("transcriber cli", () => {
  beforeEach(() => {
    mocks.access.mockReset();
    mocks.spawn.mockReset();
  });

  it("ignores non-transcriber commands", async () => {
    const out = collectStream();
    const handled = await handleTranscriberCliRequest({
      normalizedArgv: ["noop"],
      envForRun: {},
      stdout: out.stream,
      stderr: out.stream,
    });
    expect(handled).toBe(false);
    expect(out.getText()).toBe("");
  });

  it("prints help for transcriber help", async () => {
    const out = collectStream();
    const handled = await handleTranscriberCliRequest({
      normalizedArgv: ["transcriber", "help"],
      envForRun: {},
      stdout: out.stream,
      stderr: out.stream,
    });
    expect(handled).toBe(true);
    const text = out.getText();
    expect(text).toMatch(/Transcriber/i);
    expect(text).toContain(`Auto selection: ${AUTO_ORDER}.`);
  });

  it("prints setup and ONNX instructions when not configured", async () => {
    mocks.access.mockRejectedValue(new Error("missing"));
    makeSpawnResult("error");

    const out = collectStream();
    const handled = await handleTranscriberCliRequest({
      normalizedArgv: ["transcriber", "setup"],
      envForRun: {},
      stdout: out.stream,
      stderr: out.stream,
    });
    expect(handled).toBe(true);
    const text = out.getText();
    expect(text).toMatch(/Transcriber setup/);
    expect(text).toContain(`Auto order: ${AUTO_ORDER}`);
    expect(text).toMatch(/To enable ONNX locally/);
  });

  it("skips ONNX instructions when configured", async () => {
    mocks.access.mockResolvedValue(undefined);
    makeSpawnResult("close", 0);

    const out = collectStream();
    const handled = await handleTranscriberCliRequest({
      normalizedArgv: ["transcriber", "setup"],
      envForRun: { SUMMARIZE_ONNX_PARAKEET_CMD: '["sherpa-onnx"]' },
      stdout: out.stream,
      stderr: out.stream,
    });
    expect(handled).toBe(true);
    const text = out.getText();
    expect(text).toMatch(/Transcriber setup/);
    expect(text).not.toMatch(/To enable ONNX locally/);
  });

  it("throws on invalid --model", async () => {
    await expect(
      handleTranscriberCliRequest({
        normalizedArgv: ["transcriber", "setup", "--model", "nope"],
        envForRun: {},
        stdout: collectStream().stream,
        stderr: collectStream().stream,
      }),
    ).rejects.toThrow(/Unsupported --model/);
  });
});
