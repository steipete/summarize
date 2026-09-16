import { LocalizedError, message } from "../../lib/i18n";
export const isSlidesProgressKey = (key: string) =>
  /^progress\.(?:slides|extractSlides)/u.test(key);
export function shouldSurfaceStreamingStatus({
  streamedAnyNonWhitespace,
  statusText,
  messageKey,
}: {
  streamedAnyNonWhitespace: boolean;
  statusText: string;
  messageKey?: string;
}): boolean {
  const trimmed = statusText.trim().toLowerCase();
  const allowDuringStreaming = messageKey
    ? isSlidesProgressKey(messageKey)
    : trimmed.startsWith("slides:") ||
      trimmed.startsWith("slides ") ||
      trimmed.startsWith("slide:");
  return !streamedAnyNonWhitespace || allowDuringStreaming;
}

export function getTerminalStreamError(args: {
  sawDone: boolean;
  streamedAnyNonWhitespace: boolean;
}): Error | null {
  if (!args.sawDone) {
    return new LocalizedError(message("error.streamEnded"));
  }
  if (!args.streamedAnyNonWhitespace) {
    return new LocalizedError(message("error.noOutput"));
  }
  return null;
}
