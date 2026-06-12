function normalizeStreamText(input: string): string {
  return input.replace(/\r\n?/g, "\n");
}

function commonPrefixLength(a: string, b: string, limit = 4096): number {
  const max = Math.min(a.length, b.length, limit);
  let i = 0;
  for (; i < max; i += 1) {
    if (a[i] !== b[i]) break;
  }
  return i;
}

// Streaming APIs sometimes resend partial output; stitch using prefix/overlap heuristics.
export function mergeStreamingChunk(
  previous: string,
  chunk: string,
): { next: string; appended: string } {
  if (!chunk) return { next: previous, appended: "" };
  const prev = normalizeStreamText(previous);
  const nextChunk = normalizeStreamText(chunk);
  if (!prev) return { next: nextChunk, appended: nextChunk };
  if (nextChunk.startsWith(prev)) {
    return { next: nextChunk, appended: nextChunk.slice(prev.length) };
  }
  if (prev.startsWith(nextChunk)) {
    return { next: prev, appended: "" };
  }
  if (nextChunk.length >= prev.length) {
    const prefixLen = commonPrefixLength(prev, nextChunk);
    if (prefixLen > 0) {
      const minPrefix = Math.max(prev.length - 64, Math.floor(prev.length * 0.9));
      if (prefixLen >= minPrefix) {
        return { next: nextChunk, appended: nextChunk.slice(prefixLen) };
      }
    }
  }
  const maxOverlap = Math.min(prev.length, nextChunk.length, 2048);
  for (let len = maxOverlap; len > 0; len -= 1) {
    if (prev.slice(-len) === nextChunk.slice(0, len)) {
      return { next: prev + nextChunk.slice(len), appended: nextChunk.slice(len) };
    }
  }
  return { next: prev + nextChunk, appended: nextChunk };
}
