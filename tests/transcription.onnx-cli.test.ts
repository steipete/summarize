import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  resolvePreferredOnnxModel,
  transcribeWithOnnxCli,
  transcribeWithOnnxCliFile,
} from "../packages/core/src/transcription/onnx-cli.js";

const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
  vi.restoreAllMocks();
});

describe("onnx cli transcriber", () => {
  it("retries an interrupted model download without reusing a partial artifact", async () => {
    const root = await fs.mkdtemp(join(tmpdir(), "onnx-download-"));
    try {
      const filePath = join(root, "input.wav");
      await fs.writeFile(filePath, "audio");
      const env = {
        SUMMARIZE_ONNX_CACHE_DIR: join(root, "cache"),
        SUMMARIZE_ONNX_MODEL_BASE_URL: "https://example.invalid/model",
        SUMMARIZE_ONNX_PARAKEET_CMD: JSON.stringify([
          process.execPath,
          "-e",
          "process.stdout.write(require('node:fs').readFileSync(process.argv[1], 'utf8'))",
          "{model}",
        ]),
      };
      const interrupted = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("partial"));
        },
        pull(controller) {
          controller.error(new Error("download interrupted"));
        },
      });
      const fetchMock = vi
        .spyOn(global, "fetch")
        .mockResolvedValueOnce(new Response(interrupted))
        .mockResolvedValueOnce(new Response("complete-model"))
        .mockResolvedValueOnce(new Response("vocabulary"));
      const options = { model: "parakeet" as const, filePath, mediaType: "audio/wav", env };

      const failed = await transcribeWithOnnxCliFile(options);
      expect(failed.error?.message).toContain("model download failed");
      expect(await fs.readdir(join(root, "cache/parakeet"))).toEqual([]);

      const retried = await transcribeWithOnnxCliFile(options);
      expect(retried.error).toBeNull();
      expect(retried.text).toBe("complete-model");
      expect(fetchMock).toHaveBeenCalledTimes(3);
      expect((await fs.readdir(join(root, "cache/parakeet"))).sort()).toEqual([
        "model.onnx",
        "vocab.txt",
      ]);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it.each([0, 1])(
    "keeps byte input alive until the transcriber exits with %s",
    async (exitCode) => {
      const root = await fs.mkdtemp(join(tmpdir(), "onnx-input-"));
      try {
        const cacheDir = join(root, "cache");
        const modelDir = join(cacheDir, "parakeet");
        await fs.mkdir(modelDir, { recursive: true });
        await fs.writeFile(join(modelDir, "model.onnx"), "model");
        await fs.writeFile(join(modelDir, "vocab.txt"), "vocabulary");
        const recordPath = join(root, "observed-input.json");
        const env = {
          SUMMARIZE_ONNX_CACHE_DIR: cacheDir,
          SUMMARIZE_ONNX_PARAKEET_CMD: JSON.stringify([
            process.execPath,
            "-e",
            `const fs = require('node:fs');
           const input = process.argv[1];
           const content = fs.readFileSync(input, 'utf8');
           fs.writeFileSync(process.argv[2], JSON.stringify({ input, content }));
           process.stdout.write(content);
           process.exitCode = ${exitCode};`,
            "{input}",
            recordPath,
          ]),
        };

        const result = await transcribeWithOnnxCli({
          model: "parakeet",
          bytes: new TextEncoder().encode("synthetic audio"),
          mediaType: "audio/wav",
          filename: "source.wav",
          env,
        });

        const record = JSON.parse(await fs.readFile(recordPath, "utf8")) as {
          input: string;
          content: string;
        };
        expect(record.content).toBe("synthetic audio");
        await expect(fs.stat(record.input)).rejects.toThrow();
        if (exitCode === 0) {
          expect(result.error).toBeNull();
          expect(result.text).toBe("synthetic audio");
        } else {
          expect(result.error?.message).toContain("failed (1)");
        }
      } finally {
        await fs.rm(root, { recursive: true, force: true });
      }
    },
  );

  it("downloads huggingface artifacts on first run and substitutes placeholders", async () => {
    const cacheDir = join(tmpdir(), `onnx-cache-${randomUUID()}`);
    process.env.SUMMARIZE_ONNX_CACHE_DIR = cacheDir;
    process.env.SUMMARIZE_ONNX_MODEL_BASE_URL = "https://example.invalid/model";
    process.env.SUMMARIZE_ONNX_PARAKEET_CMD =
      "cat {model} {vocab} {input} >/dev/null; printf 'downloaded'";

    const responses = [new Response("dummy-model"), new Response("dummy-vocab")];
    const fetchMock = vi
      .spyOn(global, "fetch")
      .mockImplementation(async () => responses.shift() ?? new Response("", { status: 404 }));

    const filePath = join(tmpdir(), `onnx-${randomUUID()}.wav`);
    await fs.writeFile(filePath, "dummy");

    const result = await transcribeWithOnnxCliFile({
      model: "parakeet",
      filePath,
      mediaType: "audio/wav",
      totalDurationSeconds: null,
      onProgress: null,
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.text).toBe("downloaded");
    expect(await fs.readFile(join(cacheDir, "parakeet", "model.onnx"), "utf8")).toBe("dummy-model");
    expect(await fs.readFile(join(cacheDir, "parakeet", "vocab.txt"), "utf8")).toBe("dummy-vocab");

    await fs.rm(cacheDir, { recursive: true, force: true });
    await fs.unlink(filePath);
  });

  it("runs configured command with placeholder", async () => {
    const filePath = join(tmpdir(), `onnx-${randomUUID()}.bin`);
    await fs.writeFile(filePath, "dummy");

    const cacheDir = join(tmpdir(), `onnx-cache-${randomUUID()}`);
    process.env.SUMMARIZE_ONNX_CACHE_DIR = cacheDir;
    process.env.SUMMARIZE_ONNX_MODEL_BASE_URL = "https://example.invalid/model";

    vi.spyOn(global, "fetch").mockImplementation(async () => new Response("noop"));

    process.env.SUMMARIZE_ONNX_PARAKEET_CMD = "cat {input} >/dev/null; printf 'hello world'";

    const result = await transcribeWithOnnxCliFile({
      model: "parakeet",
      filePath,
      mediaType: "audio/mpeg",
      totalDurationSeconds: null,
      onProgress: null,
    });

    await fs.rm(cacheDir, { recursive: true, force: true });
    await fs.unlink(filePath);

    expect(result.provider).toBe("onnx-parakeet");
    expect(result.text).toBe("hello world");
    expect(result.error).toBeNull();
  });

  it("supports argv-style JSON command templates (no shell) and handles spaces in paths", async () => {
    const filePath = join(tmpdir(), `onnx ${randomUUID()}.wav`);
    await fs.writeFile(filePath, "dummy");

    const cacheDir = join(tmpdir(), `onnx-cache-${randomUUID()}`);
    process.env.SUMMARIZE_ONNX_CACHE_DIR = cacheDir;
    process.env.SUMMARIZE_ONNX_MODEL_BASE_URL = "https://example.invalid/model";

    vi.spyOn(global, "fetch").mockImplementation(async () => new Response("noop"));

    process.env.SUMMARIZE_ONNX_PARAKEET_CMD = JSON.stringify([
      "node",
      "-e",
      "process.stdout.write(process.argv[1] ?? '')",
      "{input}",
    ]);

    const result = await transcribeWithOnnxCliFile({
      model: "parakeet",
      filePath,
      mediaType: "audio/wav",
      totalDurationSeconds: null,
      onProgress: null,
    });

    await fs.rm(cacheDir, { recursive: true, force: true });
    await fs.unlink(filePath);

    expect(result.text).toBe(filePath);
    expect(result.error).toBeNull();
  });

  it("escapes placeholders for shell templates (spaces in paths)", async () => {
    const filePath = join(tmpdir(), `onnx shell ${randomUUID()}.wav`);
    await fs.writeFile(filePath, "dummy");

    const cacheDir = join(tmpdir(), `onnx-cache-${randomUUID()}`);
    process.env.SUMMARIZE_ONNX_CACHE_DIR = cacheDir;
    process.env.SUMMARIZE_ONNX_MODEL_BASE_URL = "https://example.invalid/model";

    vi.spyOn(global, "fetch").mockImplementation(async () => new Response("noop"));

    process.env.SUMMARIZE_ONNX_PARAKEET_CMD =
      "node -e \"process.stdout.write(process.argv[process.argv.length - 1] ?? '')\" -- {input}";

    const result = await transcribeWithOnnxCliFile({
      model: "parakeet",
      filePath,
      mediaType: "audio/wav",
      totalDurationSeconds: null,
      onProgress: null,
    });

    await fs.rm(cacheDir, { recursive: true, force: true });
    await fs.unlink(filePath);

    expect(result.text).toBe(filePath);
    expect(result.error).toBeNull();
  });

  it("uses provided env instead of process.env (daemon-style override)", async () => {
    const filePath = join(tmpdir(), `onnx-${randomUUID()}.wav`);
    await fs.writeFile(filePath, "dummy");

    delete process.env.SUMMARIZE_ONNX_PARAKEET_CMD;

    const env = {
      ...process.env,
      SUMMARIZE_ONNX_CACHE_DIR: join(tmpdir(), `onnx-cache-${randomUUID()}`),
      SUMMARIZE_ONNX_MODEL_BASE_URL: "https://example.invalid/model",
      SUMMARIZE_ONNX_PARAKEET_CMD: "cat {input} >/dev/null; printf 'ok'",
    };

    vi.spyOn(global, "fetch").mockImplementation(async () => new Response("noop"));

    const result = await transcribeWithOnnxCliFile({
      model: "parakeet",
      filePath,
      mediaType: "audio/wav",
      totalDurationSeconds: null,
      onProgress: null,
      env,
    });

    const cacheDir = env.SUMMARIZE_ONNX_CACHE_DIR;
    if (!cacheDir) throw new Error("missing SUMMARIZE_ONNX_CACHE_DIR");

    await fs.rm(cacheDir, { recursive: true, force: true });
    await fs.unlink(filePath);

    expect(result.text).toBe("ok");
    expect(result.error).toBeNull();
  });

  it("resolves preferred ONNX model from env", () => {
    expect(resolvePreferredOnnxModel({ SUMMARIZE_TRANSCRIBER: "parakeet" })).toBe("parakeet");
    expect(resolvePreferredOnnxModel({ SUMMARIZE_TRANSCRIBER: "  CANARY " })).toBe("canary");
    expect(resolvePreferredOnnxModel({ SUMMARIZE_TRANSCRIBER: "whisper" })).toBeNull();
    expect(resolvePreferredOnnxModel({})).toBeNull();
  });

  it("reports missing command", async () => {
    const filePath = join(tmpdir(), `onnx-${randomUUID()}.bin`);
    await fs.writeFile(filePath, "dummy");

    delete process.env.SUMMARIZE_ONNX_PARAKEET_CMD;

    const result = await transcribeWithOnnxCliFile({
      model: "parakeet",
      filePath,
      mediaType: "audio/mpeg",
      totalDurationSeconds: null,
      onProgress: null,
    });

    await fs.unlink(filePath);

    expect(result.text).toBeNull();
    expect(result.error).toBeInstanceOf(Error);
    expect(result.provider).toBe("onnx-parakeet");
  });
});
