import { extensionMessage } from "../../lib/i18n";
import { isBrowserAiQuotaError, type BrowserSummarizerSession } from "./browser-ai-contracts";

function splitLongUnit(value: string, target: number): string[] {
  const words = value.split(/\s+/).filter(Boolean);
  if (words.length <= 1) {
    return Array.from({ length: Math.ceil(value.length / target) }, (_unused, index) =>
      value.slice(index * target, (index + 1) * target),
    );
  }
  const chunks: string[] = [];
  let current = "";
  for (const word of words) {
    if (word.length > target) {
      if (current) chunks.push(current);
      current = "";
      chunks.push(...splitLongUnit(word, target));
      continue;
    }
    const next = current ? `${current} ${word}` : word;
    if (next.length > target && current) {
      chunks.push(current);
      current = word;
    } else {
      current = next;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

function splitNear(value: string, maxChars: number): string[] {
  const target = Math.max(1, Math.floor(maxChars));
  if (value.length <= target) return [value];
  const units = value
    .split(/\n{2,}|(?<=[.!?])\s+/)
    .map((part) => part.trim())
    .filter(Boolean);
  const chunks: string[] = [];
  let current = "";
  const flush = () => {
    if (!current) return;
    chunks.push(current);
    current = "";
  };

  for (const unit of units) {
    if (unit.length > target) {
      flush();
      chunks.push(...splitLongUnit(unit, target));
      continue;
    }
    const next = current ? `${current} ${unit}` : unit;
    if (next.length > target) flush();
    current = current ? `${current} ${unit}` : unit;
  }
  flush();
  return chunks.length > 1 ? chunks : [value.slice(0, target), value.slice(target)];
}

export async function summarizeRecursively({
  session,
  text,
  context,
  signal,
  depth = 0,
}: {
  session: BrowserSummarizerSession;
  text: string;
  context?: string;
  signal?: AbortSignal;
  depth?: number;
}): Promise<string> {
  if (signal?.aborted) throw new DOMException(extensionMessage("error.aborted"), "AbortError");
  if (depth > 8) {
    throw new DOMException(extensionMessage("error.contextWindow"), "QuotaExceededError");
  }

  const inputQuota = session.inputQuota;
  if (
    typeof inputQuota === "number" &&
    Number.isFinite(inputQuota) &&
    inputQuota > 0 &&
    session.measureInputUsage
  ) {
    const usage = await session.measureInputUsage(text, context ? { context } : undefined);
    if (usage <= inputQuota) return await session.summarize(text, { context, signal });
    const targetChars = Math.max(1_000, Math.floor((text.length * inputQuota * 0.8) / usage));
    const chunks = splitNear(text, Math.min(targetChars, Math.ceil(text.length / 2)));
    const partials: string[] = [];
    for (const chunk of chunks) {
      partials.push(
        await summarizeRecursively({
          session,
          text: chunk,
          context,
          signal,
          depth: depth + 1,
        }),
      );
    }
    return await summarizeRecursively({
      session,
      text: partials.join("\n"),
      context,
      signal,
      depth: depth + 1,
    });
  }

  try {
    return await session.summarize(text, { context, signal });
  } catch (error) {
    if (!isBrowserAiQuotaError(error) || text.length < 2_000) throw error;
    const partials: string[] = [];
    for (const chunk of splitNear(text, Math.ceil(text.length / 2))) {
      partials.push(
        await summarizeRecursively({
          session,
          text: chunk,
          context,
          signal,
          depth: depth + 1,
        }),
      );
    }
    return await summarizeRecursively({
      session,
      text: partials.join("\n"),
      context,
      signal,
      depth: depth + 1,
    });
  }
}
