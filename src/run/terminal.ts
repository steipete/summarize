type TerminalStream = NodeJS.WritableStream &
  Partial<Pick<NodeJS.WriteStream, "isTTY" | "columns" | "rows">>;

export function isRichTty(stream: NodeJS.WritableStream): boolean {
  return Boolean((stream as TerminalStream).isTTY);
}

export function supportsColor(
  stream: NodeJS.WritableStream,
  env: Record<string, string | undefined>,
): boolean {
  // Explicit override always wins.
  if (env.FORCE_COLOR) return env.FORCE_COLOR !== "0";
  if (env.NO_COLOR) return false;
  if (!isRichTty(stream)) return false;
  const term = env.TERM?.toLowerCase();
  if (!term || term === "dumb") return false;
  return true;
}

export function terminalWidth(
  stream: NodeJS.WritableStream,
  env: Record<string, string | undefined> = {},
): number {
  return terminalDimension((stream as TerminalStream).columns, env.COLUMNS, 80);
}

export function terminalHeight(
  stream: NodeJS.WritableStream,
  env: Record<string, string | undefined> = {},
): number {
  return terminalDimension((stream as TerminalStream).rows, env.LINES, 24);
}

function terminalDimension(value: unknown, envValue: string | undefined, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.floor(value);
  }
  const fromEnv = envValue ? Number(envValue) : NaN;
  if (Number.isFinite(fromEnv) && fromEnv > 0) {
    return Math.floor(fromEnv);
  }
  return fallback;
}

/** Default max width for markdown rendering to keep text readable on wide terminals. */
export const DEFAULT_MAX_RENDER_WIDTH = 120;

export function markdownRenderWidth(
  stream: NodeJS.WritableStream,
  env: Record<string, string | undefined>,
): number {
  // Avoid “phantom blank lines” from terminal auto-wrap when the rendered line hits the exact width.
  // Wrap 1 column earlier so explicit newlines don't combine with terminal soft-wrap.
  const w = terminalWidth(stream, env);
  // Cap at DEFAULT_MAX_RENDER_WIDTH to keep text readable on wide terminals (see #101).
  return Math.max(20, Math.min(w - 1, DEFAULT_MAX_RENDER_WIDTH));
}

export function ansi(code: string, input: string, enabled: boolean): string {
  if (!enabled) return input;
  return `\u001b[${code}m${input}\u001b[0m`;
}
