import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  isWhisperCppReady,
  transcribeWithWhisperCppFile,
} from "../packages/core/src/transcription/whisper/whisper-cpp.js";
import { runCli } from "../src/run.js";
import { captureStream } from "./helpers/streams.js";

const directories: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "summarize-whisper-env-"));
  directories.push(root);
  const binary = join(root, "whisper-cli");
  const modelPath = join(root, "ggml-base.bin");
  const filePath = join(root, "audio.mp3");
  await writeFile(
    binary,
    `#!/bin/sh
if [ "$1" = "--help" ]; then exit 0; fi
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--output-file" ]; then
    shift
    printf '%s' "\${SUMMARIZE_TEST_WHISPER_VALUE:-missing}" > "$1.txt"
    exit 0
  fi
  shift
done
exit 2
`,
  );
  await chmod(binary, 0o700);
  await writeFile(modelPath, new Uint8Array([1]));
  await writeFile(filePath, new Uint8Array([0xff, 0xfb, 0x10, 0x00]));
  const env = {
    SUMMARIZE_DISABLE_LOCAL_WHISPER_CPP: "0",
    SUMMARIZE_WHISPER_CPP_BINARY: binary,
    SUMMARIZE_WHISPER_CPP_MODEL_PATH: modelPath,
  };
  return { root, binary, filePath, env };
}

describe.skipIf(process.platform === "win32")("whisper.cpp child environment", () => {
  it("discovers a binary on the supplied PATH", async () => {
    const input = await fixture();
    const env = { ...input.env, PATH: input.root, SUMMARIZE_WHISPER_CPP_BINARY: "whisper-cli" };
    expect(spawnSync("whisper-cli", ["--help"], { env }).status).toBe(0);
    expect(await isWhisperCppReady(env)).toBe(true);
  });

  it("inherits ambient PATH and variables when the supplied environment is partial", async () => {
    const input = await fixture();
    vi.stubEnv("PATH", `${input.root}${delimiter}${process.env.PATH ?? ""}`);
    vi.stubEnv("SUMMARIZE_TEST_WHISPER_VALUE", "ambient");
    const result = await transcribeWithWhisperCppFile({
      filePath: input.filePath,
      mediaType: "audio/mpeg",
      totalDurationSeconds: null,
      env: { ...input.env, SUMMARIZE_WHISPER_CPP_BINARY: "whisper-cli" },
    });
    expect(result.error).toBeNull();
    expect(result.text).toBe("ambient");
  });

  it("gives supplied child variables precedence without mutating process.env", async () => {
    const input = await fixture();
    vi.stubEnv("SUMMARIZE_TEST_WHISPER_VALUE", "ambient");
    const result = await transcribeWithWhisperCppFile({
      filePath: input.filePath,
      mediaType: "audio/mpeg",
      totalDurationSeconds: null,
      env: { ...input.env, SUMMARIZE_TEST_WHISPER_VALUE: "configured" },
    });
    expect(result.error).toBeNull();
    expect(result.text).toBe("configured");
    expect(process.env.SUMMARIZE_TEST_WHISPER_VALUE).toBe("ambient");
  });

  it("retains the normal process environment when env is omitted", async () => {
    const input = await fixture();
    for (const [key, value] of Object.entries(input.env)) vi.stubEnv(key, value);
    vi.stubEnv("SUMMARIZE_TEST_WHISPER_VALUE", "ambient");
    expect(await isWhisperCppReady()).toBe(true);
    const result = await transcribeWithWhisperCppFile({
      filePath: input.filePath,
      mediaType: "audio/mpeg",
      totalDurationSeconds: null,
    });
    expect(result.text).toBe("ambient");
  });

  it("passes config-only variables to local transcription through the CLI", async () => {
    const input = await fixture();
    await mkdir(join(input.root, ".summarize"));
    await writeFile(
      join(input.root, ".summarize", "config.json"),
      JSON.stringify({
        env: {
          ...input.env,
          SUMMARIZE_TEST_WHISPER_VALUE: "configured",
          YT_DLP_PATH: input.binary,
        },
        cache: { enabled: false },
      }),
    );
    const stdout = captureStream();
    await runCli(["--extract", "--plain", "--metrics", "off", input.filePath], {
      env: { HOME: input.root },
      fetch: vi.fn(async () => {
        throw new Error("Unexpected network request");
      }),
      stdout: stdout.stream,
      stderr: captureStream().stream,
    });
    expect(stdout.getText()).toContain("configured");
  });
});
