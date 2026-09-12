import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  isWhisperCppReady,
  resolveWhisperCppModelNameForDisplay,
} from "../packages/core/src/transcription/whisper.js";

const mock = vi.hoisted(() => ({ mode: "ok" as "ok" | "error" | "nonzero" }));

vi.mock("node:child_process", () => ({
  spawn: vi.fn((_binary: string, args: string[]) => {
    expect(args).toEqual(["--help"]);
    const proc = new EventEmitter();
    process.nextTick(() => {
      if (mock.mode === "error") proc.emit("error", new Error("spawn failed"));
      else proc.emit("close", mock.mode === "nonzero" ? 1 : 0);
    });
    return proc;
  }),
}));

function createModel() {
  const modelPath = join(
    mkdtempSync(join(tmpdir(), "summarize-whisper-ready-")),
    "ggml-base.en.bin",
  );
  writeFileSync(modelPath, "fixture");
  return modelPath;
}

describe("whisper.cpp readiness", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mock.mode = "ok";
  });
  afterEach(() => vi.unstubAllEnvs());

  it("does not probe disabled local whisper.cpp", async () => {
    expect(
      await isWhisperCppReady({
        SUMMARIZE_DISABLE_LOCAL_WHISPER_CPP: "1",
        SUMMARIZE_WHISPER_CPP_MODEL_PATH: createModel(),
      }),
    ).toBe(false);
    expect(spawn).not.toHaveBeenCalled();
  });

  it.each(["error", "nonzero"] as const)("rejects an unavailable executable: %s", async (mode) => {
    mock.mode = mode;
    expect(await isWhisperCppReady({ SUMMARIZE_WHISPER_CPP_MODEL_PATH: createModel() })).toBe(
      false,
    );
    expect(spawn).toHaveBeenCalledOnce();
  });

  it.each(["unset", "missing", "directory"] as const)(
    "does not probe without a usable model: %s",
    async (kind) => {
      const root = mkdtempSync(join(tmpdir(), "summarize-whisper-no-model-"));
      const env =
        kind === "unset"
          ? {}
          : {
              SUMMARIZE_WHISPER_CPP_MODEL_PATH:
                kind === "directory" ? root : join(root, "missing.bin"),
            };
      expect(await isWhisperCppReady(env)).toBe(false);
      expect(spawn).not.toHaveBeenCalled();
    },
  );

  it("accepts a valid model and derives its display name", async () => {
    const env = { SUMMARIZE_WHISPER_CPP_MODEL_PATH: createModel() };
    expect(await isWhisperCppReady(env)).toBe(true);
    expect(await resolveWhisperCppModelNameForDisplay(env)).toBe("base");
  });

  it("discovers cached models under HOME", async () => {
    const home = mkdtempSync(join(tmpdir(), "summarize-whisper-home-"));
    const directory = join(home, ".summarize", "cache", "whisper-cpp", "models");
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "ggml-base.bin"), "fixture");
    expect(await isWhisperCppReady({ HOME: home })).toBe(true);
    expect(await resolveWhisperCppModelNameForDisplay({ HOME: home })).toBe("base");
  });

  it("uses explicit env instead of process model settings", async () => {
    vi.stubEnv("SUMMARIZE_DISABLE_LOCAL_WHISPER_CPP", "1");
    vi.stubEnv("SUMMARIZE_WHISPER_CPP_MODEL_PATH", "/missing/process/model.bin");
    const env = { SUMMARIZE_WHISPER_CPP_MODEL_PATH: createModel() };
    expect(await isWhisperCppReady(env)).toBe(true);
    expect(await resolveWhisperCppModelNameForDisplay(env)).toBe("base");
  });
});
