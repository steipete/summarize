/**
 * Some reasoning models expose their chain-of-thought inline in the normal text
 * channel of the OpenAI-compatible chat-completions transport, wrapped in
 * `<think>…</think>`. First-party providers (OpenAI Responses, Anthropic,
 * Google, xAI) keep reasoning on a separate channel, so they never leak and must
 * NOT be listed here.
 *
 * Single source of truth: to change which providers get reasoning-tag stripping,
 * add or remove the provider id below. Defaults to `minimax` only so existing
 * providers keep their current output unchanged.
 */
export const REASONING_TAG_STRIP_PROVIDERS: ReadonlySet<string> = new Set<string>(["minimax"]);

export function providerStripsReasoningTags(provider: string): boolean {
  return REASONING_TAG_STRIP_PROVIDERS.has(provider);
}

const OPEN_TAG = "<think>";
const CLOSE_TAG = "</think>";

/**
 * Remove a single leading `<think>…</think>` reasoning block from a complete
 * response. Conservative by design:
 * - only strips when the opening tag is at the very start (ignoring leading
 *   whitespace), or when a closing tag appears with no opening tag before it
 *   (a truncated/dangling reasoning trace);
 * - never strips `<think>` that appears mid-content (e.g. legitimate text that
 *   happens to mention the tag).
 *
 * Returns the text with only leading whitespace trimmed from the remainder; the
 * rest of the formatting is preserved.
 */
export function stripReasoningTags(text: string): string {
  const closeIdx = text.indexOf(CLOSE_TAG);
  if (closeIdx === -1) return text;

  const openIdx = text.indexOf(OPEN_TAG);
  const isLeadingBlock =
    openIdx !== -1 && openIdx < closeIdx && text.slice(0, openIdx).trim() === "";
  const isDanglingClose = openIdx === -1 || openIdx > closeIdx;
  if (!isLeadingBlock && !isDanglingClose) return text;

  return text.slice(closeIdx + CLOSE_TAG.length).replace(/^\s+/, "");
}

/**
 * Stateful streaming variant of {@link stripReasoningTags}. Suppresses a leading
 * `<think>…</think>` block across delta boundaries (tags may be split between
 * chunks) and forwards everything after the closing tag. If the stream does not
 * begin with a reasoning block, it passes through unchanged.
 */
export function createReasoningTagFilter(): {
  push: (delta: string) => string;
  flush: () => string;
} {
  let state: "start" | "thinking" | "done" = "start";
  let buffer = "";

  const push = (delta: string): string => {
    if (state === "done") return delta;
    buffer += delta;

    if (state === "start") {
      const leading = buffer.replace(/^\s+/, "");
      if (leading.length === 0) return "";
      if (leading.startsWith(OPEN_TAG)) {
        state = "thinking";
      } else if (OPEN_TAG.startsWith(leading)) {
        // buffer so far is a prefix of "<think>" — wait for more deltas.
        return "";
      } else {
        // Not a reasoning block; flush buffered text and pass through.
        state = "done";
        const out = buffer;
        buffer = "";
        return out;
      }
    }

    // state === "thinking"
    const closeIdx = buffer.indexOf(CLOSE_TAG);
    if (closeIdx === -1) return "";
    const after = buffer.slice(closeIdx + CLOSE_TAG.length);
    buffer = "";
    state = "done";
    return after.replace(/^\s+/, "");
  };

  const flush = (): string => {
    if (state === "start" && buffer.length > 0) {
      const out = buffer;
      buffer = "";
      state = "done";
      return out;
    }
    // "thinking" with no closing tag → drop the buffered reasoning.
    buffer = "";
    state = "done";
    return "";
  };

  return { push, flush };
}
