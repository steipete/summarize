import type { ProcessHandle } from "../processes.js";
import { spawnTracked } from "../processes.js";

export type ProcessCommand =
  | string
  | {
      command: string;
      argsPrefix?: string[];
      source?: "wasm";
    };

function resolveProcessCommand(command: ProcessCommand, args: string[]) {
  if (typeof command === "string") return { command, args };
  return {
    command: command.command,
    args: [...(command.argsPrefix ?? []), ...args],
  };
}

type ProcessOptions = {
  command: ProcessCommand;
  args: string[];
  timeoutMs: number;
  errorLabel: string;
};

type ProcessLineHandler = (line: string, handle: ProcessHandle | null) => void;
type ProcessLineOptions = ProcessOptions & {
  onStderrLine?: ProcessLineHandler;
  onStdoutLine?: ProcessLineHandler;
};

function readProcessLines(
  stream: NodeJS.ReadableStream | null,
  onLine: (line: string) => void,
  onChunk?: (chunk: string) => void,
): () => void {
  let buffer = "";
  stream?.setEncoding("utf8");
  stream?.on("data", (chunk: string) => {
    onChunk?.(chunk);
    buffer += chunk;
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (line) onLine(line);
    }
  });
  return () => {
    if (buffer.trim()) onLine(buffer.trim());
  };
}

function runProcessWithOutput(options: ProcessLineOptions, mode: "lines"): Promise<void>;
function runProcessWithOutput(options: ProcessOptions, mode: "text"): Promise<string>;
function runProcessWithOutput(options: ProcessOptions, mode: "buffer"): Promise<Buffer>;
function runProcessWithOutput(
  options: ProcessLineOptions,
  mode: "lines" | "text" | "buffer",
): Promise<void | string | Buffer> {
  const { command, args, timeoutMs, errorLabel, onStderrLine, onStdoutLine } = options;
  return new Promise((resolve, reject) => {
    const resolved = resolveProcessCommand(command, args);
    const { proc, handle } = spawnTracked(resolved.command, resolved.args, {
      stdio: ["ignore", "pipe", "pipe"],
      label: errorLabel,
      kind: errorLabel,
      captureOutput: false,
    });
    let stderr = "";
    let stdout = "";
    const chunks: Buffer[] = [];
    const appendError = (text: string) => {
      if (stderr.length < 8192) stderr += text;
    };
    const flushStderr = readProcessLines(
      proc.stderr,
      (line) => {
        if (mode === "lines") onStderrLine?.(line, handle);
        handle?.appendOutput("stderr", line);
        if (mode === "lines") appendError(`${line}\n`);
      },
      mode === "lines" ? undefined : appendError,
    );

    const stdoutHandler = onStdoutLine ?? onStderrLine;
    let flushStdout: (() => void) | undefined;
    if (mode === "buffer") {
      proc.stdout?.on("data", (chunk: Buffer) => chunks.push(chunk));
    } else if (mode === "text" || stdoutHandler) {
      flushStdout = readProcessLines(
        proc.stdout,
        (line) => {
          if (mode === "lines") stdoutHandler?.(line, handle);
          handle?.appendOutput("stdout", line);
        },
        mode === "text"
          ? (chunk) => {
              stdout += chunk;
            }
          : undefined,
      );
    } else {
      proc.stdout?.resume();
    }

    const timeout = setTimeout(() => {
      proc.kill("SIGKILL");
      reject(new Error(`${errorLabel} timed out`));
    }, timeoutMs);
    proc.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    proc.on("close", (code) => {
      clearTimeout(timeout);
      if (mode === "lines") flushStderr();
      flushStdout?.();
      if (mode !== "lines") flushStderr();
      if (code === 0) {
        resolve(mode === "buffer" ? Buffer.concat(chunks) : mode === "text" ? stdout : undefined);
      } else {
        const suffix = stderr.trim() ? `: ${stderr.trim()}` : "";
        reject(new Error(`${errorLabel} exited with code ${code}${suffix}`));
      }
    });
  });
}

export async function runProcess(options: ProcessLineOptions): Promise<void> {
  await runProcessWithOutput(options, "lines");
}

export async function runProcessCapture(options: ProcessOptions): Promise<string> {
  return runProcessWithOutput(options, "text");
}

export async function runProcessCaptureBuffer(options: ProcessOptions): Promise<Buffer> {
  return runProcessWithOutput(options, "buffer");
}

export async function runWithConcurrency<T>(
  tasks: Array<() => Promise<T>>,
  workers: number,
  onProgress?: ((completed: number, total: number) => void) | null,
): Promise<T[]> {
  if (tasks.length === 0) return [];
  const concurrency = Math.max(1, Math.min(16, Math.round(workers)));
  const results: T[] = new Array(tasks.length);
  const total = tasks.length;
  let completed = 0;
  let nextIndex = 0;

  const worker = async () => {
    while (true) {
      const current = nextIndex;
      if (current >= tasks.length) return;
      nextIndex += 1;
      try {
        results[current] = await tasks[current]();
      } finally {
        completed += 1;
        onProgress?.(completed, total);
      }
    }
  };

  const runners = Array.from({ length: Math.min(concurrency, tasks.length) }, () => worker());
  await Promise.all(runners);
  return results;
}
