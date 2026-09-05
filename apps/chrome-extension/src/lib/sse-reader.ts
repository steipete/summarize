import type { RawSseMessage } from "@steipete/summarize-core/runtime";

export async function nextSseMessage(
  iterator: AsyncIterator<RawSseMessage>,
  idleTimeoutMs: number,
  idleTimeoutMessage: string,
): Promise<IteratorResult<RawSseMessage>> {
  if (!Number.isFinite(idleTimeoutMs) || idleTimeoutMs <= 0) return iterator.next();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<IteratorResult<RawSseMessage>>((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error(idleTimeoutMessage);
      error.name = "IdleTimeoutError";
      reject(error);
    }, idleTimeoutMs);
  });
  try {
    return await Promise.race([iterator.next(), timeout]);
  } finally {
    clearTimeout(timer);
  }
}
