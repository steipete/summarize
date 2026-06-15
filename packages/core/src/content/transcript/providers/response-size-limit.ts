export const MAX_REMOTE_TRANSCRIPT_BYTES = 5 * 1024 * 1024;

export async function readTranscriptTextWithLimit(
  res: Response,
  maxBytes = MAX_REMOTE_TRANSCRIPT_BYTES,
): Promise<string> {
  const contentLength = res.headers.get("content-length");
  if (contentLength) {
    const parsed = Number(contentLength);
    if (Number.isFinite(parsed) && parsed > maxBytes) {
      await res.body?.cancel().catch(() => {});
      throw new Error(`transcript too large (${parsed} bytes). Limit is ${maxBytes} bytes.`);
    }
  }

  if (!res.body) {
    const arrayBuffer = await res.arrayBuffer();
    if (arrayBuffer.byteLength > maxBytes) {
      throw new Error(
        `transcript too large (${arrayBuffer.byteLength} bytes). Limit is ${maxBytes} bytes.`,
      );
    }
    return new TextDecoder().decode(arrayBuffer);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let received = 0;
  let text = "";

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new Error(`transcript too large (${received} bytes). Limit is ${maxBytes} bytes.`);
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return text;
  } finally {
    reader.releaseLock();
  }
}
