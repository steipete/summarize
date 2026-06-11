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

export async function runProcess({
  command,
  args,
  timeoutMs,
  errorLabel,
  onStderrLine,
  onStdoutLine,
}: {
  command: ProcessCommand;
  args: string[];
  timeoutMs: number;
  errorLabel: string;
  onStderrLine?: (line: string, handle: ProcessHandle | null) => void;
  onStdoutLine?: (line: string, handle: ProcessHandle | null) => void;
}): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const resolved = resolveProcessCommand(command, args);
    const { proc, handle } = spawnTracked(resolved.command, resolved.args, {
      stdio: ["ignore", "pipe", "pipe"],
      label: errorLabel,
      kind: errorLabel,
      captureOutput: false,
    });
    let stderr = "";
    let stderrBuffer = "";
    let stdoutBuffer = "";

    const flushLine = (line: string) => {
      onStderrLine?.(line, handle);
      handle?.appendOutput("stderr", line);
      if (stderr.length < 8192) {
        stderr += line;
        if (!line.endsWith("\n")) stderr += "\n";
      }
    };

    if (proc.stderr) {
      proc.stderr.setEncoding("utf8");
      proc.stderr.on("data", (chunk: string) => {
        stderrBuffer += chunk;
        const lines = stderrBuffer.split(/\r?\n/);
        stderrBuffer = lines.pop() ?? "";
        for (const line of lines) {
          if (line) flushLine(line);
        }
      });
    }

    if (proc.stdout) {
      const handleStdoutLine = onStdoutLine ?? onStderrLine;
      if (handleStdoutLine) {
        proc.stdout.setEncoding("utf8");
        proc.stdout.on("data", (chunk: string) => {
          stdoutBuffer += chunk;
          const lines = stdoutBuffer.split(/\r?\n/);
          stdoutBuffer = lines.pop() ?? "";
          for (const line of lines) {
            if (!line) continue;
            handleStdoutLine(line, handle);
            handle?.appendOutput("stdout", line);
          }
        });
      }
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
      if (stderrBuffer.trim().length > 0) flushLine(stderrBuffer.trim());
      if (stdoutBuffer.trim().length > 0) {
        const handleStdoutLine = onStdoutLine ?? onStderrLine;
        if (handleStdoutLine) handleStdoutLine(stdoutBuffer.trim(), handle);
        handle?.appendOutput("stdout", stdoutBuffer.trim());
      }
      if (code === 0) {
        resolve();
        return;
      }
      const suffix = stderr.trim() ? `: ${stderr.trim()}` : "";
      reject(new Error(`${errorLabel} exited with code ${code}${suffix}`));
    });
  });
}

export async function runProcessCapture({
  command,
  args,
  timeoutMs,
  errorLabel,
}: {
  command: ProcessCommand;
  args: string[];
  timeoutMs: number;
  errorLabel: string;
}): Promise<string> {
  return new Promise((resolve, reject) => {
    const resolved = resolveProcessCommand(command, args);
    const { proc, handle } = spawnTracked(resolved.command, resolved.args, {
      stdio: ["ignore", "pipe", "pipe"],
      label: errorLabel,
      kind: errorLabel,
      captureOutput: false,
    });
    let stdout = "";
    let stderr = "";
    let stdoutBuffer = "";
    let stderrBuffer = "";

    const timeout = setTimeout(() => {
      proc.kill("SIGKILL");
      reject(new Error(`${errorLabel} timed out`));
    }, timeoutMs);

    if (proc.stdout) {
      proc.stdout.setEncoding("utf8");
      proc.stdout.on("data", (chunk: string) => {
        stdout += chunk;
        stdoutBuffer += chunk;
        const lines = stdoutBuffer.split(/\r?\n/);
        stdoutBuffer = lines.pop() ?? "";
        for (const line of lines) {
          if (line) handle?.appendOutput("stdout", line);
        }
      });
    }

    if (proc.stderr) {
      proc.stderr.setEncoding("utf8");
      proc.stderr.on("data", (chunk: string) => {
        if (stderr.length < 8192) stderr += chunk;
        stderrBuffer += chunk;
        const lines = stderrBuffer.split(/\r?\n/);
        stderrBuffer = lines.pop() ?? "";
        for (const line of lines) {
          if (line) handle?.appendOutput("stderr", line);
        }
      });
    }

    proc.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });

    proc.on("close", (code) => {
      clearTimeout(timeout);
      if (stdoutBuffer.trim()) handle?.appendOutput("stdout", stdoutBuffer.trim());
      if (stderrBuffer.trim()) handle?.appendOutput("stderr", stderrBuffer.trim());
      if (code === 0) {
        resolve(stdout);
        return;
      }
      const suffix = stderr.trim() ? `: ${stderr.trim()}` : "";
      reject(new Error(`${errorLabel} exited with code ${code}${suffix}`));
    });
  });
}

export async function runProcessCaptureBuffer({
  command,
  args,
  timeoutMs,
  errorLabel,
}: {
  command: ProcessCommand;
  args: string[];
  timeoutMs: number;
  errorLabel: string;
}): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const resolved = resolveProcessCommand(command, args);
    const { proc, handle } = spawnTracked(resolved.command, resolved.args, {
      stdio: ["ignore", "pipe", "pipe"],
      label: errorLabel,
      kind: errorLabel,
      captureOutput: false,
    });
    const chunks: Buffer[] = [];
    let stderr = "";
    let stderrBuffer = "";

    const timeout = setTimeout(() => {
      proc.kill("SIGKILL");
      reject(new Error(`${errorLabel} timed out`));
    }, timeoutMs);

    if (proc.stdout) {
      proc.stdout.on("data", (chunk: Buffer) => {
        chunks.push(chunk);
      });
    }

    if (proc.stderr) {
      proc.stderr.setEncoding("utf8");
      proc.stderr.on("data", (chunk: string) => {
        if (stderr.length < 8192) stderr += chunk;
        stderrBuffer += chunk;
        const lines = stderrBuffer.split(/\r?\n/);
        stderrBuffer = lines.pop() ?? "";
        for (const line of lines) {
          if (line) handle?.appendOutput("stderr", line);
        }
      });
    }

    proc.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });

    proc.on("close", (code) => {
      clearTimeout(timeout);
      if (stderrBuffer.trim()) handle?.appendOutput("stderr", stderrBuffer.trim());
      if (code === 0) {
        resolve(Buffer.concat(chunks));
        return;
      }
      const suffix = stderr.trim() ? `: ${stderr.trim()}` : "";
      reject(new Error(`${errorLabel} exited with code ${code}${suffix}`));
    });
  });
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
