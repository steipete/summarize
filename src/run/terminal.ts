export function isRichTty(stream: NodeJS.WritableStream): boolean {
  return Boolean((stream as unknown as { isTTY?: boolean }).isTTY);
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
  env: Record<string, string | undefined>,
): number {
  const cols = (stream as unknown as { columns?: unknown }).columns;
  if (typeof cols === "number" && Number.isFinite(cols) && cols > 0) {
    return Math.floor(cols);
  }
  const fromEnv = env.COLUMNS ? Number(env.COLUMNS) : NaN;
  if (Number.isFinite(fromEnv) && fromEnv > 0) {
    return Math.floor(fromEnv);
  }
  return 80;
}

export function terminalHeight(
  stream: NodeJS.WritableStream,
  env: Record<string, string | undefined>,
): number {
  const rows = (stream as unknown as { rows?: unknown }).rows;
  if (typeof rows === "number" && Number.isFinite(rows) && rows > 0) {
    return Math.floor(rows);
  }
  const fromEnv = env.LINES ? Number(env.LINES) : NaN;
  if (Number.isFinite(fromEnv) && fromEnv > 0) {
    return Math.floor(fromEnv);
  }
  return 24;
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
