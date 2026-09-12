export function shouldSurfaceStreamingStatus({
  streamedAnyNonWhitespace,
  statusText,
}: {
  streamedAnyNonWhitespace: boolean;
  statusText: string;
}): boolean {
  const trimmed = statusText.trim().toLowerCase();
  const allowDuringStreaming =
    trimmed.startsWith("slides:") || trimmed.startsWith("slides ") || trimmed.startsWith("slide:");
  return !streamedAnyNonWhitespace || allowDuringStreaming;
}

export function getTerminalStreamError(args: {
  sawDone: boolean;
  streamedAnyNonWhitespace: boolean;
}): Error | null {
  if (!args.sawDone) {
    return new Error("Stream ended unexpectedly. The daemon may have stopped.");
  }
  if (!args.streamedAnyNonWhitespace) {
    return new Error("Model returned no output.");
  }
  return null;
}
