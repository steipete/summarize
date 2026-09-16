export type SpinnerColor = "cyan" | "magenta" | "yellow" | "green" | "gray" | "blue";

const SPINNER_INTERVAL_MS = 80;
const SPINNER_FRAMES = [
  "⢀⠀",
  "⡀⠀",
  "⠄⠀",
  "⢂⠀",
  "⡂⠀",
  "⠅⠀",
  "⢃⠀",
  "⡃⠀",
  "⠍⠀",
  "⢋⠀",
  "⡋⠀",
  "⠍⠁",
  "⢋⠁",
  "⡋⠁",
  "⠍⠉",
  "⠋⠉",
  "⠋⠉",
  "⠉⠙",
  "⠉⠙",
  "⠉⠩",
  "⠈⢙",
  "⠈⡙",
  "⢈⠩",
  "⡀⢙",
  "⠄⡙",
  "⢂⠩",
  "⡂⢘",
  "⠅⡘",
  "⢃⠨",
  "⡃⢐",
  "⠍⡐",
  "⢋⠠",
  "⡋⢀",
  "⠍⡁",
  "⢋⠁",
  "⡋⠁",
  "⠍⠉",
  "⠋⠉",
  "⠋⠉",
  "⠉⠙",
  "⠉⠙",
  "⠉⠩",
  "⠈⢙",
  "⠈⡙",
  "⠈⠩",
  "⠀⢙",
  "⠀⡙",
  "⠀⠩",
  "⠀⢘",
  "⠀⡘",
  "⠀⠨",
  "⠀⢐",
  "⠀⡐",
  "⠀⠠",
  "⠀⢀",
  "⠀⡀",
] as const;

const COLOR_CODES: Record<SpinnerColor, number> = {
  cyan: 36,
  magenta: 35,
  yellow: 33,
  green: 32,
  gray: 90,
  blue: 34,
};

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
  color?: SpinnerColor;
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
  let frameIndex = 0;
  let currentText = text;
  let timer: NodeJS.Timeout | null = null;
  const colorCode = COLOR_CODES[color ?? "cyan"];

  const render = () => {
    if (ended || paused || !hasVisibleText(currentText)) return;
    const frame = SPINNER_FRAMES[frameIndex % SPINNER_FRAMES.length] ?? "";
    frameIndex = (frameIndex + 1) % SPINNER_FRAMES.length;
    // i18n-ignore: Terminal control sequence; the caller supplies the localized label.
    stream.write(`\r\u001b[2K\u001b[${colorCode}m${frame}\u001b[0m ${currentText}`);
  };

  const stopTimer = () => {
    if (!timer) return;
    clearInterval(timer);
    timer = null;
  };

  const startTimer = () => {
    if (timer || ended || paused) return;
    render();
    timer = setInterval(render, SPINNER_INTERVAL_MS);
    timer.unref?.();
  };

  const clear = () => {
    if (ended) return;
    stream.write("\r\u001b[2K");
  };

  const pause = () => {
    if (ended || paused) return;
    paused = true;
    stopTimer();
    stream.write("\r\u001b[2K");
  };

  const resume = () => {
    if (ended || !paused) return;
    paused = false;
    startTimer();
  };

  const refresh = () => {
    if (ended || paused) return;
    if (!hasVisibleText(currentText)) return;
    const now = Date.now();
    if (now - lastRenderAt < 80) return;
    lastRenderAt = now;
    render();
  };

  const stop = () => {
    if (ended) return;
    ended = true;
    stopTimer();
  };

  const stopAndClear = () => {
    if (ended) return;
    ended = true;
    paused = false;
    stopTimer();
    stream.write("\r\u001b[2K");
  };

  const setText = (next: string) => {
    if (ended) return;
    if (!hasVisibleText(next)) return;
    if (currentText === next) return;
    currentText = next;
    if (!paused) {
      refresh();
    }
  };

  startTimer();

  return { stop, clear, pause, refresh, resume, stopAndClear, setText };
}
