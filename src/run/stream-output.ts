export type StreamOutputMode = "line" | "delta";

function terminalColumns(stream: NodeJS.WritableStream): number {
  const columns = (stream as unknown as { columns?: unknown }).columns;
  return typeof columns === "number" && Number.isFinite(columns) && columns > 0
    ? Math.floor(columns)
    : 80;
}

function terminalRows(stream: NodeJS.WritableStream): number {
  const rows = (stream as unknown as { rows?: unknown }).rows;
  return typeof rows === "number" && Number.isFinite(rows) && rows > 0 ? Math.floor(rows) : 24;
}

type SegmenterLike = {
  segment: (input: string) => Iterable<{ segment: string }>;
};

type SegmenterConstructor = new (
  locales?: string | string[],
  options?: { granularity?: "grapheme" },
) => SegmenterLike;

const splitGraphemes = (() => {
  const Segmenter = (Intl as unknown as { Segmenter?: SegmenterConstructor }).Segmenter;
  if (!Segmenter) return (input: string) => Array.from(input);
  const segmenter = new Segmenter(undefined, { granularity: "grapheme" });
  return (input: string) => Array.from(segmenter.segment(input), (part) => part.segment);
})();

function isZeroWidthCodePoint(codePoint: number): boolean {
  return (
    codePoint === 0x200d ||
    (codePoint >= 0x300 && codePoint <= 0x36f) ||
    (codePoint >= 0x1ab0 && codePoint <= 0x1aff) ||
    (codePoint >= 0x1dc0 && codePoint <= 0x1dff) ||
    (codePoint >= 0x20d0 && codePoint <= 0x20ff) ||
    (codePoint >= 0xfe00 && codePoint <= 0xfe0f) ||
    (codePoint >= 0xfe20 && codePoint <= 0xfe2f)
  );
}

function isWideCodePoint(codePoint: number): boolean {
  return (
    (codePoint >= 0x1100 && codePoint <= 0x115f) ||
    (codePoint >= 0x2329 && codePoint <= 0x232a) ||
    (codePoint >= 0x2e80 && codePoint <= 0xa4cf) ||
    (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
    (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
    (codePoint >= 0xfe10 && codePoint <= 0xfe19) ||
    (codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
    (codePoint >= 0xff00 && codePoint <= 0xff60) ||
    (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
    (codePoint >= 0x20000 && codePoint <= 0x3fffd)
  );
}

function isRegionalIndicatorCodePoint(codePoint: number): boolean {
  return codePoint >= 0x1f1e6 && codePoint <= 0x1f1ff;
}

function isEmojiModifierCodePoint(codePoint: number): boolean {
  return codePoint >= 0x1f3fb && codePoint <= 0x1f3ff;
}

function isEmojiModifierBaseCodePoint(codePoint: number): boolean {
  return codePoint === 0x261d || (codePoint >= 0x270a && codePoint <= 0x270d);
}

function isEmojiCodePoint(codePoint: number): boolean {
  return (
    (codePoint >= 0x1f300 && codePoint <= 0x1faff) ||
    codePoint === 0x2614 ||
    codePoint === 0x2615 ||
    (codePoint >= 0x2648 && codePoint <= 0x2653) ||
    codePoint === 0x267f ||
    codePoint === 0x2693 ||
    codePoint === 0x26a1 ||
    (codePoint >= 0x26aa && codePoint <= 0x26ab) ||
    (codePoint >= 0x26bd && codePoint <= 0x26be) ||
    (codePoint >= 0x26c4 && codePoint <= 0x26c5) ||
    codePoint === 0x26ce ||
    codePoint === 0x26d4 ||
    codePoint === 0x26ea ||
    (codePoint >= 0x26f2 && codePoint <= 0x26f3) ||
    codePoint === 0x26f5 ||
    codePoint === 0x26fa ||
    codePoint === 0x26fd ||
    codePoint === 0x2705 ||
    codePoint === 0x2728 ||
    codePoint === 0x274c ||
    codePoint === 0x274e ||
    (codePoint >= 0x2753 && codePoint <= 0x2755) ||
    codePoint === 0x2757 ||
    (codePoint >= 0x2795 && codePoint <= 0x2797) ||
    codePoint === 0x27b0 ||
    codePoint === 0x27bf
  );
}

function codePointCellWidth(codePoint: number): number {
  return isWideCodePoint(codePoint) ? 2 : 1;
}

function isHalfwidthFullwidthForm(codePoint: number): boolean {
  return codePoint >= 0xff00 && codePoint <= 0xffef;
}

function textGraphemeCellWidth(visibleCodePoints: readonly number[]): number {
  const first = visibleCodePoints[0];
  if (typeof first !== "number") return 0;
  let width = codePointCellWidth(first);
  for (const codePoint of visibleCodePoints.slice(1)) {
    if (isHalfwidthFullwidthForm(codePoint)) {
      width += codePointCellWidth(codePoint);
    }
  }
  return width;
}

function displayCellWidth(grapheme: string): number {
  const visibleCodePoints: number[] = [];
  let hasEmoji = false;
  let hasEmojiPresentation = false;
  let hasTextPresentation = false;
  let hasEmojiModifierBase = false;
  let hasEmojiModifier = false;
  let regionalIndicatorCount = 0;
  for (const char of grapheme) {
    const codePoint = char.codePointAt(0) ?? 0;
    if (codePoint === 0xfe0e) {
      hasTextPresentation = true;
    }
    if (codePoint === 0xfe0f || codePoint === 0x20e3) {
      hasEmojiPresentation = true;
    }
    if (codePoint === 0 || codePoint < 32 || (codePoint >= 0x7f && codePoint < 0xa0)) {
      continue;
    }
    if (isEmojiModifierCodePoint(codePoint)) {
      hasEmojiModifier = true;
      if (hasEmoji || hasEmojiModifierBase) {
        continue;
      }
    }
    if (isZeroWidthCodePoint(codePoint)) {
      continue;
    }
    visibleCodePoints.push(codePoint);
    if (isRegionalIndicatorCodePoint(codePoint)) {
      regionalIndicatorCount += 1;
      continue;
    }
    if (isEmojiCodePoint(codePoint)) {
      hasEmoji = true;
    }
    if (isEmojiModifierBaseCodePoint(codePoint)) {
      hasEmojiModifierBase = true;
    }
  }
  if (visibleCodePoints.length === 0) return 0;
  if (hasTextPresentation) return textGraphemeCellWidth(visibleCodePoints);
  if (
    hasEmoji ||
    hasEmojiPresentation ||
    (hasEmojiModifier && hasEmojiModifierBase) ||
    regionalIndicatorCount >= 2
  ) {
    return 2;
  }
  return textGraphemeCellWidth(visibleCodePoints);
}

function visualLineCount(text: string, columns: number): number {
  let lines = 1;
  let column = 0;
  for (const grapheme of splitGraphemes(text.replace(/\r\n?/g, "\n"))) {
    if (grapheme === "\n") {
      lines += 1;
      column = 0;
      continue;
    }
    const width = displayCellWidth(grapheme);
    column += width;
    if (column > columns) {
      lines += 1;
      column = width;
    }
  }
  return lines;
}

function rewindPrintedLines(lines: number): string {
  let sequence = "\r\u001b[2K";
  for (let i = 1; i < lines; i += 1) {
    sequence += "\u001b[1A\r\u001b[2K";
  }
  return sequence;
}

export function createStreamOutputGate({
  stdout,
  clearProgressForStdout,
  restoreProgressAfterStdout,
  outputMode,
  richTty,
  rewriteOnReplacement = false,
  restoreDuringStream = true,
}: {
  stdout: NodeJS.WritableStream;
  clearProgressForStdout: () => void;
  restoreProgressAfterStdout?: (() => void) | null;
  outputMode: StreamOutputMode;
  richTty: boolean;
  rewriteOnReplacement?: boolean;
  restoreDuringStream?: boolean;
}) {
  let cleared = false;
  let plainFlushedLen = 0;
  let plainLeadingSkipLen = 0;
  let plainFlushedText = "";
  let pendingFinalReprint: string | null = null;
  const columns = terminalColumns(stdout);
  const rows = terminalRows(stdout);

  const ensureCleared = () => {
    if (cleared) return;
    clearProgressForStdout();
    if (richTty) stdout.write("\n");
    cleared = true;
  };

  const clearBeforeWrite = () => {
    if (restoreDuringStream) clearProgressForStdout();
  };

  const flush = (text: string) => {
    clearBeforeWrite();
    stdout.write(text);
    plainFlushedText += text;
    if (restoreDuringStream) restoreProgressAfterStdout?.();
  };

  const handleChunk = (streamed: string, prevStreamed: string) => {
    if (pendingFinalReprint !== null) {
      pendingFinalReprint = streamed;
      return;
    }

    if (plainFlushedLen === 0) {
      const match = streamed.match(/^\n+/);
      if (match) {
        plainLeadingSkipLen = match[0].length;
        plainFlushedLen = match[0].length;
      }
    }

    if (outputMode === "line") {
      const lastNl = streamed.lastIndexOf("\n");
      if (lastNl >= 0 && lastNl + 1 > plainFlushedLen) {
        ensureCleared();
        flush(streamed.slice(plainFlushedLen, lastNl + 1));
        plainFlushedLen = lastNl + 1;
      }
      return;
    }

    const isAppendOnly = streamed.startsWith(prevStreamed);
    if (streamed.length > plainFlushedLen && isAppendOnly) {
      ensureCleared();
      flush(streamed.slice(plainFlushedLen));
      plainFlushedLen = streamed.length;
      return;
    }
    if (!isAppendOnly) {
      ensureCleared();
      if (rewriteOnReplacement && plainFlushedLen > 0) {
        const replacement = streamed.slice(plainLeadingSkipLen);
        const printedLines = visualLineCount(plainFlushedText, columns);
        if (printedLines > rows) {
          // Cursor-up cannot reach scrolled-off terminal history; avoid replaying over a partial viewport.
          pendingFinalReprint = streamed;
          return;
        }
        if (restoreDuringStream) clearProgressForStdout();
        stdout.write(`${rewindPrintedLines(printedLines)}${replacement}`);
        if (restoreDuringStream) restoreProgressAfterStdout?.();
        plainFlushedLen = streamed.length;
        plainFlushedText = replacement;
        return;
      }
      plainFlushedText = "";
      flush(streamed);
      plainFlushedLen = streamed.length;
    }
  };

  const finalize = (finalText: string) => {
    if (pendingFinalReprint !== null) {
      const corrected = finalText || pendingFinalReprint;
      let reprint = plainFlushedText && !plainFlushedText.endsWith("\n") ? "\n" : "";
      reprint += corrected.replace(/^\n+/, "");
      if (!reprint.endsWith("\n")) reprint += "\n";
      clearBeforeWrite();
      stdout.write(reprint);
      restoreProgressAfterStdout?.();
      plainFlushedLen = finalText.length;
      plainFlushedText += reprint;
      pendingFinalReprint = null;
      return;
    }

    const remaining = plainFlushedLen < finalText.length ? finalText.slice(plainFlushedLen) : "";
    if (remaining) {
      clearBeforeWrite();
      stdout.write(remaining);
      plainFlushedText += remaining;
      restoreProgressAfterStdout?.();
    }
    const endedWithNewline = remaining
      ? remaining.endsWith("\n")
      : plainFlushedLen > 0 && finalText[plainFlushedLen - 1] === "\n";
    if (!endedWithNewline) {
      clearBeforeWrite();
      stdout.write("\n");
      plainFlushedText += "\n";
      restoreProgressAfterStdout?.();
    }
  };

  return { handleChunk, finalize, getFlushedLen: () => plainFlushedLen };
}
