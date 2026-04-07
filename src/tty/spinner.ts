import ora, { type Options as OraOptions } from "ora";

function hasVisibleText(input: string): boolean {
  // Strip CSI and OSC escape sequences before checking for visible text.
  const withoutAnsi = input
    .replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\u001B\][^\u0007]*(?:\u0007|\u001B\\)/g, "");
  return withoutAnsi.trim().length > 0;
}

export function startSpinner({
  text,
  enabled,
  stream,
  color,
}: {
  text: string;
  enabled: boolean;
  stream: NodeJS.WritableStream;
  color?: OraOptions["color"];
}): {
  stop: () => void;
  clear: () => void;
  pause: () => void;
  refresh: () => void;
  resume: () => void;
  stopAndClear: () => void;
  setText: (next: string) => void;
} {
  if (!enabled) {
    return {
      stop: () => {},
      clear: () => {},
      pause: () => {},
      refresh: () => {},
      resume: () => {},
      stopAndClear: () => {},
      setText: () => {},
    };
  }

  let ended = false;
  let paused = false;
  let lastRenderAt = 0;

  const oraStream = stream as typeof stream & {
    cursorTo?: (x: number, y?: number) => void;
    clearLine?: (dir: number) => void;
    moveCursor?: (dx: number, dy: number) => void;
  };

  if (typeof oraStream.cursorTo !== "function") oraStream.cursorTo = () => {};
  if (typeof oraStream.clearLine !== "function") oraStream.clearLine = () => {};
  if (typeof oraStream.moveCursor !== "function") oraStream.moveCursor = () => {};

  const clear = () => {
    if (ended) return;
    // Keep output clean in scrollback.
    // `ora` clears the line, but we also hard-clear as a fallback.
    spinner.clear();
    stream.write("\r\u001b[2K");
  };

  const pause = () => {
    if (ended || paused) return;
    paused = true;
    if (spinner.isSpinning) spinner.stop();
    spinner.clear();
    stream.write("\r\u001b[2K");
  };

  const resume = () => {
    if (ended || !paused) return;
    paused = false;
    spinner.start();
  };

  const refresh = () => {
    if (ended || paused) return;
    if (!hasVisibleText(spinner.text)) return;
    const now = Date.now();
    if (now - lastRenderAt < 80) return;
    lastRenderAt = now;
    spinner.render?.();
  };

  const stop = () => {
    if (ended) return;
    ended = true;
    if (spinner.isSpinning) spinner.stop();
  };

  const stopAndClear = () => {
    if (ended) return;
    ended = true;
    paused = false;
    if (spinner.isSpinning) spinner.stop();
    spinner.clear();
    stream.write("\r\u001b[2K");
  };

  const setText = (next: string) => {
    if (ended) return;
    if (!hasVisibleText(next)) return;
    if (spinner.text === next) return;
    spinner.text = next;
    if (!paused) {
      refresh();
    }
  };

  const spinner = ora({
    text,
    stream: oraStream,
    // Match Sweetistics CLI vibe; keep it clean.
    spinner: "dots12",
    color: color ?? "cyan",
    discardStdin: true,
  }).start();

  return { stop, clear, pause, refresh, resume, stopAndClear, setText };
}
