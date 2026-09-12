import { cpus } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const rootDir = dirname(fileURLToPath(import.meta.url));
const cpuCount = Math.max(1, cpus().length);
const POSITIVE_INTEGER_PATTERN = /^[1-9]\d*$/u;

export function resolveMaxThreads(raw: string | undefined, availableCpus = cpuCount): number {
  const cpuBudget = Math.max(1, Math.floor(availableCpus));
  const fallback = Math.min(cpuBudget, 8, Math.max(4, Math.floor(cpuBudget / 2)));
  const value = raw?.trim();
  if (!value || !POSITIVE_INTEGER_PATTERN.test(value)) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) ? parsed : fallback;
}

export function createVitestConfig({
  env = process.env,
  availableCpus = cpuCount,
}: {
  env?: Record<string, string | undefined>;
  availableCpus?: number;
} = {}) {
  const maxWorkers = resolveMaxThreads(env.VITEST_MAX_THREADS, availableCpus);
  const coverageReporters = env.CI ? ["text", "json-summary", "html"] : ["text", "json-summary"];
  return defineConfig({
    resolve: {
      alias: [
        {
          find: /^@steipete\/summarize-core\/content$/,
          replacement: resolve(rootDir, "packages/core/src/content/index.ts"),
        },
        {
          find: /^@steipete\/summarize-core\/content\/url$/,
          replacement: resolve(rootDir, "packages/core/src/content/url.ts"),
        },
        {
          find: /^@steipete\/summarize-core\/content\/youtube-captions$/,
          replacement: resolve(rootDir, "packages/core/src/content/youtube-captions.ts"),
        },
        {
          find: /^@steipete\/summarize-core\/prompts$/,
          replacement: resolve(rootDir, "packages/core/src/prompts/index.ts"),
        },
        {
          find: /^@steipete\/summarize-core\/language$/,
          replacement: resolve(rootDir, "packages/core/src/language.ts"),
        },
        {
          find: /^@steipete\/summarize-core\/ffmpeg$/,
          replacement: resolve(rootDir, "packages/core/src/ffmpeg.ts"),
        },
        {
          find: /^@steipete\/summarize-core\/processes$/,
          replacement: resolve(rootDir, "packages/core/src/processes.ts"),
        },
        {
          find: /^@steipete\/summarize-core$/,
          replacement: resolve(rootDir, "packages/core/src/index.ts"),
        },
      ],
    },
    test: {
      maxWorkers,
      fsModuleCache: true,
      environment: "node",
      include: ["tests/**/*.test.ts"],
      setupFiles: ["tests/setup.ts"],
      hookTimeout: 15_000,
      testTimeout: 15_000,
      coverage: {
        provider: "v8",
        reporter: coverageReporters,
        include: ["src/**/*.ts", "packages/core/src/**/*.ts"],
        exclude: [
          "**/*.d.ts",
          "**/dist/**",
          "**/node_modules/**",
          "tests/**",
          // The extension has its own browser-focused test and coverage pipeline.
          "apps/chrome-extension/**",
          // Daemon is integration-tested / manually tested; unit coverage is noisy + brittle.
          "**/src/daemon/**",
          // Slide extraction is integration-tested; unit coverage is too noisy.
          "src/slides/download.ts",
          "src/slides/extract-finalize.ts",
          "src/slides/extract.ts",
          "src/slides/frame-extraction.ts",
          "src/slides/ocr.ts",
          "src/slides/process.ts",
          "src/slides/ingest.ts",
          "src/slides/scene-detection.ts",
          // Generated ffmpeg-wasm adapter; exercised through the maintained wrapper.
          "packages/core/src/ffmpeg-wasm/run-generated.ts",
          // External process/provider adapters are exercised through integration-focused suites.
          "packages/core/src/content/dns-pinned-fetch.ts",
          "packages/core/src/content/transcript/providers/youtube/native-media.ts",
          "packages/core/src/content/transcript/providers/youtube/yt-dlp-media.ts",
          "packages/core/src/content/transcript/providers/youtube/yt-dlp-process.ts",
          "packages/core/src/transcription/onnx-cli.ts",
          "packages/core/src/transcription/whisper/assemblyai.ts",
          "packages/core/src/transcription/whisper/core.ts",
          "packages/core/src/transcription/whisper/diarization.ts",
          "packages/core/src/transcription/whisper/elevenlabs.ts",
          "packages/core/src/transcription/whisper/fal-client.ts",
          "packages/core/src/transcription/whisper/fal.ts",
          "packages/core/src/transcription/whisper/ffmpeg.ts",
          "packages/core/src/transcription/whisper/gemini.ts",
          "packages/core/src/transcription/whisper/groq.ts",
          "packages/core/src/transcription/whisper/openai.ts",
          "packages/core/src/transcription/whisper/remote.ts",
          "packages/core/src/transcription/whisper/whisper-cpp.ts",
          // OS/browser integration (exec/sqlite/keychain); covered via higher-level tests.
          "**/src/content/transcript/providers/twitter-cookies-*.ts",
          // Barrels / type-only entrypoints (noise for coverage).
          "src/**/index.ts",
          "src/**/types.ts",
          "src/**/contracts.ts",
          "src/**/slides-text.ts",
          "src/**/slides-text-types.ts",
          "src/**/deps.ts",
        ],
        thresholds: {
          branches: 85,
          functions: 85,
          lines: 85,
          statements: 85,
        },
      },
    },
  });
}

export default createVitestConfig();
