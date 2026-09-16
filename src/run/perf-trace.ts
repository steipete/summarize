type PerfEvent = {
  name: string;
  elapsedMs: number;
  detail?: string | null;
};

export type PerfTrace = {
  mark: (name: string, detail?: string | null) => void;
  wrapStdout: (stdout: NodeJS.WritableStream) => NodeJS.WritableStream;
  finish: (detail?: string | null) => void;
};

function isPerfTraceEnabled(env: Record<string, string | undefined>): boolean {
  const value = env.SUMMARIZE_PERF_TRACE?.trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes";
}

function formatMs(value: number): string {
  return `${value.toFixed(value < 10 ? 1 : 0)}ms`;
}

export function createPerfTrace({
  env,
  stderr,
}: {
  env: Record<string, string | undefined>;
  stderr: NodeJS.WritableStream;
}): PerfTrace | null {
  if (!isPerfTraceEnabled(env)) return null;
  const startedAt = performance.now();
  const events: PerfEvent[] = [];
  let firstStdout = false;
  let finished = false;

  const mark = (name: string, detail?: string | null) => {
    events.push({
      name,
      elapsedMs: performance.now() - startedAt,
      detail: detail?.trim() || null,
    });
  };

  mark("cli:start");

  return {
    mark,
    wrapStdout(stdout) {
      const wrapped = Object.create(stdout) as NodeJS.WritableStream;
      wrapped.write = ((chunk: unknown, ...args: unknown[]) => {
        if (!firstStdout) {
          firstStdout = true;
          const bytes =
            typeof chunk === "string"
              ? Buffer.byteLength(chunk)
              : Buffer.isBuffer(chunk)
                ? chunk.byteLength
                : null;
          mark("stdout:first-write", bytes == null ? null : `bytes=${bytes.toString()}`);
        }
        return (stdout.write as (...writeArgs: unknown[]) => unknown).call(stdout, chunk, ...args);
      }) as NodeJS.WritableStream["write"];
      return wrapped;
    },
    finish(detail?: string | null) {
      if (finished) return;
      finished = true;
      mark("cli:finish", detail ?? null);
      // i18n-ignore: Machine-readable prefix for opt-in performance diagnostics.
      stderr.write("[summarize:perf]\n");
      for (const event of events) {
        const suffix = event.detail ? ` ${event.detail}` : "";
        stderr.write(`  ${formatMs(event.elapsedMs)} ${event.name}${suffix}\n`);
      }
    },
  };
}
