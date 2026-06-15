export type SseMessage = { event: string; data: string };

export async function* parseSseStream(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<SseMessage> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  let currentEvent = "message";
  let currentData = "";

  const flush = () => {
    const data = currentData.endsWith("\n") ? currentData.slice(0, -1) : currentData;
    const evt = currentEvent || "message";
    currentEvent = "message";
    currentData = "";
    return data ? ({ event: evt, data } as const) : null;
  };

  const parseField = (line: string) => {
    const colonIndex = line.indexOf(":");
    if (colonIndex === -1) {
      return { name: line, value: "" };
    }
    const value = line.slice(colonIndex + 1);
    return {
      name: line.slice(0, colonIndex),
      value: value.startsWith(" ") ? value.slice(1) : value,
    };
  };

  const commentValue = (line: string) => {
    const value = line.slice(1);
    return value.startsWith(" ") ? value.slice(1) : value;
  };

  const processLine = (line: string): SseMessage | null => {
    if (line === "") {
      return flush();
    }

    if (line.startsWith(":")) {
      return { event: "__comment__", data: commentValue(line).trim() };
    }
    const field = parseField(line);
    if (field.name === "event") {
      currentEvent = field.value.trim() || "message";
      return null;
    }
    if (field.name === "data") {
      currentData += `${field.value}\n`;
    }
    return null;
  };

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    while (true) {
      const idx = buffer.indexOf("\n");
      if (idx === -1) break;
      const rawLine = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      const line = rawLine.replace(/\r$/, "");

      const msg = processLine(line);
      if (msg) yield msg;
    }
  }

  buffer += decoder.decode();
  if (buffer) {
    const msg = processLine(buffer.replace(/\r$/, ""));
    if (msg) yield msg;
  }
  const msg = flush();
  if (msg) yield msg;
}
