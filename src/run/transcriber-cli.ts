import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { loadSummarizeConfig } from "../config.js";
import {
  createThemeRenderer,
  resolveThemeNameFromSources,
  resolveTrueColor,
} from "../tty/theme.js";
import { buildTranscriberHelp, TRANSCRIBER_AUTO_ORDER_DESCRIPTION } from "./help.js";
import { supportsColor } from "./terminal.js";

type TranscriberCliContext = {
  normalizedArgv: string[];
  envForRun: Record<string, string | undefined>;
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
};

type OnnxModel = "parakeet" | "canary";

const ONNX_ENV: Record<OnnxModel, string> = {
  parakeet: "SUMMARIZE_ONNX_PARAKEET_CMD",
  canary: "SUMMARIZE_ONNX_CANARY_CMD",
};

const ONNX_MODELS: OnnxModel[] = ["parakeet", "canary"];

const parseModel = (value: string | null): OnnxModel => {
  if (!value) return "parakeet";
  const normalized = value.trim().toLowerCase();
  if (normalized === "parakeet" || normalized === "canary") return normalized;
  throw new Error(`Unsupported --model: ${value}`);
};

const readArgValue = (normalizedArgv: string[], name: string): string | null => {
  const eq = normalizedArgv.find((arg) => arg.startsWith(`${name}=`));
  if (eq) return eq.slice(`${name}=`.length).trim() || null;
  const index = normalizedArgv.indexOf(name);
  if (index === -1) return null;
  const next = normalizedArgv[index + 1];
  if (!next || next.startsWith("-")) return null;
  return next.trim() || null;
};

const fileExists = async (filePath: string): Promise<boolean> => {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
};

const isBinaryAvailable = async (
  binary: string,
  env: Record<string, string | undefined>,
): Promise<boolean> => {
  return new Promise((resolve) => {
    const proc = spawn(binary, ["--help"], {
      stdio: ["ignore", "ignore", "ignore"],
      env,
    });
    proc.on("error", () => resolve(false));
    proc.on("close", (code) => resolve(code === 0));
  });
};

const resolveOnnxCacheDir = (env: Record<string, string | undefined>): string => {
  const override = env.SUMMARIZE_ONNX_CACHE_DIR?.trim();
  if (override) return override;
  const base = env.XDG_CACHE_HOME?.trim() || path.join(homedir(), ".cache");
  return path.join(base, "summarize", "onnx");
};

const resolveWhisperCppModelPath = (env: Record<string, string | undefined>): string => {
  const override = env.SUMMARIZE_WHISPER_CPP_MODEL_PATH?.trim();
  if (override) return override;
  return path.join(homedir(), ".summarize", "cache", "whisper-cpp", "models", "ggml-base.bin");
};

const renderOnnxEnvExample = (model: OnnxModel): string[] => {
  if (model === "canary") {
    return [
      `export ${ONNX_ENV.canary}='["sherpa-onnx", "--tokens", "{vocab}", "--offline-ctc-model", "{model}", "--input-wav", "{input}"]'`,
    ];
  }
  return [
    `export ${ONNX_ENV.parakeet}='["sherpa-onnx", "--tokens", "{vocab}", "--offline-ctc-model", "{model}", "--input-wav", "{input}"]'`,
  ];
};

export async function handleTranscriberCliRequest({
  normalizedArgv,
  envForRun,
  stdout,
}: TranscriberCliContext): Promise<boolean> {
  if (normalizedArgv[0]?.toLowerCase() !== "transcriber") return false;

  const subcommand = normalizedArgv[1]?.toLowerCase() ?? "help";
  const help =
    subcommand === "help" || normalizedArgv.includes("--help") || normalizedArgv.includes("-h");

  if (help) {
    stdout.write(`${buildTranscriberHelp()}\n`);
    return true;
  }

  if (subcommand !== "setup") {
    throw new Error(`Unknown transcriber command: ${subcommand}`);
  }

  const model = parseModel(readArgValue(normalizedArgv, "--model"));
  const { config } = loadSummarizeConfig({ env: envForRun });
  const themeName = resolveThemeNameFromSources({
    cli: readArgValue(normalizedArgv, "--theme"),
    env: envForRun.SUMMARIZE_THEME,
    config: config?.ui?.theme,
  });
  (envForRun as Record<string, string | undefined>).SUMMARIZE_THEME = themeName;
  const theme = createThemeRenderer({
    themeName,
    enabled: supportsColor(stdout, envForRun),
    trueColor: resolveTrueColor(envForRun),
  });
  const heading = (text: string) => theme.heading(text);
  const label = (text: string) => theme.label(text);
  const value = (text: string) => theme.value(text);
  const dim = (text: string) => theme.dim(text);
  const transcriberEnv = envForRun.SUMMARIZE_TRANSCRIBER?.trim() || "auto";

  const onnxStatus = ONNX_MODELS.map((candidate) => {
    const envKey = ONNX_ENV[candidate];
    const cmd = envForRun[envKey]?.trim();
    return { model: candidate, envKey, configured: Boolean(cmd) };
  });

  const onnxCacheDir = resolveOnnxCacheDir(envForRun);
  const onnxModelDir = path.join(onnxCacheDir, model);
  const modelPath = path.join(onnxModelDir, "model.onnx");
  const vocabPath = path.join(onnxModelDir, "vocab.txt");
  const modelReady = (await fileExists(modelPath)) && (await fileExists(vocabPath));

  const whisperBinary = envForRun.SUMMARIZE_WHISPER_CPP_BINARY?.trim() || "whisper-cli";
  const whisperCliReady = await isBinaryAvailable(whisperBinary, envForRun);
  const whisperModelPath = resolveWhisperCppModelPath(envForRun);
  const whisperModelReady = await fileExists(whisperModelPath);

  stdout.write(`${heading("Transcriber setup")}\n`);
  stdout.write(`${label("Transcriber mode:")} ${value(transcriberEnv)}\n`);
  stdout.write(`${label("Auto order:")} ${value(TRANSCRIBER_AUTO_ORDER_DESCRIPTION)}\n`);
  stdout.write("\n");
  for (const entry of onnxStatus) {
    stdout.write(
      `${label(`ONNX ${entry.model}:`)} ${value(
        entry.configured ? "configured" : "not configured",
      )} ${dim(`(${entry.envKey})`)}\n`,
    );
  }
  stdout.write(`${label("ONNX cache:")} ${value(onnxCacheDir)}\n`);
  stdout.write(
    `${label(`ONNX ${model} artifacts:`)} ${value(modelReady ? "present" : "missing")}\n`,
  );
  stdout.write("\n");
  stdout.write(
    `${label("whisper.cpp:")} ${value(whisperCliReady ? "binary ok" : "binary missing")} ${dim(
      `(${whisperBinary})`,
    )}\n`,
  );
  stdout.write(
    `${label("whisper.cpp model:")} ${value(
      whisperModelReady ? "present" : "missing",
    )} ${dim(`(${whisperModelPath})`)}\n`,
  );
  stdout.write("\n");

  if (!onnxStatus.some((entry) => entry.configured)) {
    stdout.write(`${heading("To enable ONNX locally:")}\n`);
    stdout.write(
      `  ${dim("Install sherpa-onnx from upstream binaries or build; Homebrew may not have a formula.")}\n`,
    );
    for (const line of renderOnnxEnvExample(model)) {
      stdout.write(`  ${line}\n`);
    }
    stdout.write(
      "  # placeholders: {input}, {model}, {vocab}, {model_dir} (see docs/nvidia-onnx-transcription.md)\n",
    );
    stdout.write(`  ${dim("# docs: docs/nvidia-onnx-transcription.md")}\n`);
    stdout.write("\n");
  }

  stdout.write(`${heading("Next:")}\n`);
  stdout.write(`  ${value('summarize "https://..." --slides')}\n`);
  stdout.write(
    `  ${value('SUMMARIZE_TRANSCRIBER=auto summarize "https://..." --extract --format md')}\n`,
  );
  return true;
}
