import { AsyncLocalStorage } from "node:async_hooks";
import type {
  ChildProcess,
  ExecFileException,
  ExecFileOptions,
  SpawnOptions,
} from "node:child_process";
import { execFile, spawn, spawnSync } from "node:child_process";

export type ProcessContext = {
  runId?: string | null;
  source?: string | null;
};

type ExecFileCallback = (
  error: ExecFileException | null,
  stdout: string | Buffer,
  stderr: string | Buffer,
) => void;

export type ProcessRegistration = {
  command: string;
  args: string[];
  label?: string | null;
  kind?: string | null;
  cwd?: string | null;
  env?: Record<string, string | undefined> | null;
  runId?: string | null;
  source?: string | null;
};

export type ProcessHandle = {
  id: string;
  setPid: (pid: number | null) => void;
  appendOutput: (stream: "stdout" | "stderr", line: string) => void;
  setProgress: (progress: number | null, detail?: string | null) => void;
  setStatus: (text: string | null) => void;
  finish: (result: {
    exitCode: number | null;
    signal: string | null;
    error?: string | null;
  }) => void;
};

export type ProcessObserver = {
  register: (info: ProcessRegistration) => ProcessHandle;
};

export type SpawnTrackedOptions = SpawnOptions & {
  label?: string | null;
  kind?: string | null;
  runId?: string | null;
  source?: string | null;
  captureOutput?: boolean;
};

const processContext = new AsyncLocalStorage<ProcessContext>();
let processObserver: ProcessObserver | null = null;
const activeTrackedProcesses = new Map<ChildProcess, { processGroup: boolean }>();

export function setProcessObserver(next: ProcessObserver | null): void {
  processObserver = next;
}

export function getProcessContext(): ProcessContext {
  return processContext.getStore() ?? {};
}

export function runWithProcessContext<T>(ctx: ProcessContext, fn: () => T): T {
  return processContext.run(ctx, fn);
}

function registerProcess(info: ProcessRegistration): ProcessHandle | null {
  if (!processObserver) return null;
  const ctx = getProcessContext();
  return processObserver.register({
    ...info,
    runId: info.runId ?? ctx.runId ?? null,
    source: info.source ?? ctx.source ?? null,
  });
}

function registerActiveProcess(proc: ChildProcess, processGroup: boolean): void {
  activeTrackedProcesses.set(proc, { processGroup });
  const cleanup = () => {
    activeTrackedProcesses.delete(proc);
  };
  proc.on("error", cleanup);
  proc.on("close", cleanup);
}

export function terminateTrackedProcesses(signal: NodeJS.Signals): void {
  for (const [proc, metadata] of activeTrackedProcesses) {
    if (proc.exitCode !== null || proc.signalCode !== null) {
      activeTrackedProcesses.delete(proc);
      continue;
    }

    if (process.platform === "win32" && proc.pid) {
      const result = spawnSync("taskkill", ["/PID", String(proc.pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
      if (result.status === 0) continue;
    }

    if (metadata.processGroup && proc.pid) {
      try {
        process.kill(-proc.pid, signal);
        continue;
      } catch {
        // The group may have exited between the state check and signal.
      }
    }

    try {
      proc.kill(signal);
    } catch {
      // Process already exited.
    }
  }
}

type LineListener = (line: string) => void;

function attachLineReader(stream: NodeJS.ReadableStream | null | undefined, onLine: LineListener) {
  if (!stream) return;
  let buffer = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk: string) => {
    buffer += chunk;
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (line === "") continue;
      onLine(line);
    }
  });
  stream.on("end", () => {
    const line = buffer.trim();
    if (line) onLine(line);
    buffer = "";
  });
}

export function trackChildProcess(
  proc: ChildProcess,
  info: ProcessRegistration,
  options?: { captureOutput?: boolean; processGroup?: boolean },
): ProcessHandle | null {
  registerActiveProcess(proc, options?.processGroup === true);
  const handle = registerProcess(info);
  if (!handle) return null;
  handle.setPid(proc.pid ?? null);

  const captureOutput = options?.captureOutput !== false;
  if (captureOutput) {
    attachLineReader(proc.stdout, (line) => handle.appendOutput("stdout", line));
    attachLineReader(proc.stderr, (line) => handle.appendOutput("stderr", line));
  }

  let finished = false;
  const finishOnce = (result: {
    exitCode: number | null;
    signal: string | null;
    error?: string | null;
  }) => {
    if (finished) return;
    finished = true;
    handle.finish(result);
  };

  proc.on("error", (error) => {
    const message = error instanceof Error ? error.message : String(error);
    finishOnce({ exitCode: null, signal: null, error: message });
  });
  proc.on("close", (code, signal) => {
    finishOnce({ exitCode: code ?? null, signal: signal ?? null });
  });
  return handle;
}

export function spawnTracked(
  command: string,
  args: string[],
  options: SpawnTrackedOptions = {},
): { proc: ChildProcess; handle: ProcessHandle | null } {
  const { label, kind, runId, source, captureOutput, ...spawnOptions } = options;
  const processGroup = process.platform !== "win32" && spawnOptions.detached !== false;
  const effectiveSpawnOptions =
    processGroup && spawnOptions.detached === undefined
      ? { ...spawnOptions, detached: true }
      : spawnOptions;
  const proc = spawn(command, args, effectiveSpawnOptions);
  const handle = trackChildProcess(
    proc,
    {
      command,
      args,
      label,
      kind,
      runId,
      source,
      cwd: effectiveSpawnOptions.cwd ? String(effectiveSpawnOptions.cwd) : null,
      env: effectiveSpawnOptions.env ?? null,
    },
    { captureOutput, processGroup },
  );
  return { proc, handle };
}

export function execFileTracked(
  file: string,
  args?: readonly string[] | ExecFileOptions | ExecFileCallback,
  options?: ExecFileOptions | ExecFileCallback,
  callback?: ExecFileCallback,
): ChildProcess {
  let resolvedArgs: readonly string[] = [];
  let resolvedOptions: ExecFileOptions = {};
  let resolvedCallback: ExecFileCallback | undefined;

  if (Array.isArray(args)) {
    resolvedArgs = args;
    if (typeof options === "function") {
      resolvedCallback = options;
    } else {
      resolvedOptions = options ?? {};
      resolvedCallback = callback;
    }
  } else if (typeof args === "function") {
    resolvedCallback = args;
  } else {
    resolvedOptions = (args ?? {}) as ExecFileOptions;
    if (typeof options === "function") {
      resolvedCallback = options;
    }
  }

  const proc = execFile(file, resolvedArgs, resolvedOptions, resolvedCallback as ExecFileCallback);
  trackChildProcess(
    proc,
    {
      command: file,
      args: Array.from(resolvedArgs),
      label: file,
      kind: file,
      cwd: resolvedOptions.cwd ? String(resolvedOptions.cwd) : null,
      env: resolvedOptions.env ?? null,
    },
    { captureOutput: true },
  );
  return proc;
}
