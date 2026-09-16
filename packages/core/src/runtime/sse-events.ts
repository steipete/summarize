import type { MessageDescriptor } from "../localization/index.js";
import type { MetricPart } from "../localization/presentation.js";
export type SseMetaData = {
  model: string | null;
  modelLabel: string | null;
  inputSummary: string | null;
  inputSummaryMessage?: MessageDescriptor | null;
  summaryFromCache?: boolean | null;
};

export type SseSlidesData = {
  sourceUrl: string;
  sourceId: string;
  sourceKind: string;
  slideRuntime?: "browser" | "daemon";
  ocrAvailable: boolean;
  transcriptTimedText?: string | null;
  slides: Array<{
    index: number;
    timestamp: number;
    imageUrl: string;
    ocrText?: string | null;
    ocrConfidence?: number | null;
  }>;
};

export type SseMetricsData = {
  parts?: MetricPart[];
  elapsedMs: number;
  summary: string;
  details: string | null;
  summaryDetailed: string;
  detailsDetailed: string | null;
};

export type SseEvent<TAssistant = unknown> =
  | { event: "meta"; data: SseMetaData }
  | { event: "slides"; data: SseSlidesData }
  | { event: "status"; data: { text: string; message?: MessageDescriptor } }
  | { event: "chunk"; data: { text: string } }
  | { event: "assistant"; data: TAssistant }
  | { event: "metrics"; data: SseMetricsData }
  | { event: "done"; data: Record<string, never> }
  | { event: "error"; data: { message: string; localized?: MessageDescriptor } };

export type RawSseMessage = { event: string; data: string };

function parseSseField(line: string): { name: string; value: string } {
  const colonIndex = line.indexOf(":");
  if (colonIndex === -1) return { name: line, value: "" };
  const value = line.slice(colonIndex + 1);
  return {
    name: line.slice(0, colonIndex),
    value: value.startsWith(" ") ? value.slice(1) : value,
  };
}

export async function* parseSseStream(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<RawSseMessage> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let currentEvent = "message";
  let dataLines: string[] = [];

  const flush = (): RawSseMessage | null => {
    const data = dataLines.join("\n");
    const event = currentEvent || "message";
    currentEvent = "message";
    dataLines = [];
    return data ? { event, data } : null;
  };

  const processLine = (line: string): RawSseMessage | null => {
    if (line === "") return flush();
    if (line.startsWith(":")) {
      const value = line.slice(1);
      return {
        event: "__comment__",
        data: (value.startsWith(" ") ? value.slice(1) : value).trim(),
      };
    }
    const field = parseSseField(line);
    if (field.name === "event") {
      currentEvent = field.value.trim() || "message";
    } else if (field.name === "data") {
      dataLines.push(field.value);
    }
    return null;
  };

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      while (true) {
        const newlineIndex = buffer.indexOf("\n");
        if (newlineIndex === -1) break;
        const line = buffer.slice(0, newlineIndex).replace(/\r$/, "");
        buffer = buffer.slice(newlineIndex + 1);
        const message = processLine(line);
        if (message) yield message;
      }
    }

    buffer += decoder.decode();
    if (buffer) {
      const message = processLine(buffer.replace(/\r$/, ""));
      if (message) yield message;
    }
    const message = flush();
    if (message) yield message;
  } finally {
    reader.releaseLock();
  }
}

export function encodeSseEvent<TAssistant>(event: SseEvent<TAssistant>): string {
  return `event: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`;
}

export function parseSseEvent<TAssistant = unknown>(
  message: RawSseMessage,
): SseEvent<TAssistant> | null {
  switch (message.event) {
    case "meta":
      return { event: "meta", data: JSON.parse(message.data) as SseMetaData };
    case "slides":
      return { event: "slides", data: JSON.parse(message.data) as SseSlidesData };
    case "status":
      return {
        event: "status",
        data: JSON.parse(message.data) as { text: string; message?: MessageDescriptor },
      };
    case "chunk":
      return { event: "chunk", data: JSON.parse(message.data) as { text: string } };
    case "assistant":
      return { event: "assistant", data: JSON.parse(message.data) as TAssistant };
    case "metrics":
      return { event: "metrics", data: JSON.parse(message.data) as SseMetricsData };
    case "done":
      return { event: "done", data: JSON.parse(message.data) as Record<string, never> };
    case "error":
      return {
        event: "error",
        data: JSON.parse(message.data) as { message: string; localized?: MessageDescriptor },
      };
    default:
      return null;
  }
}
