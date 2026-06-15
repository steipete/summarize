import { buildLogLine, parseLogMtime, type ExtensionLogEvent } from "./extension-log-format";

type ExtensionLogResult = {
  ok: boolean;
  lines: string[];
  truncated: boolean;
  sizeBytes: number;
  mtimeMs: number | null;
};

const LOG_KEY = "summarize:extension-logs";
const MAX_LOG_LINES = 4000;
const FLUSH_DELAY_MS = 250;
const FLUSH_BATCH = 50;

let flushTimer = 0;
let flushInFlight = false;
let pendingLines: string[] = [];

const getStorage = () => {
  if (typeof chrome === "undefined") return undefined;
  return chrome.storage?.session ?? chrome.storage?.local;
};

const queueFlush = () => {
  if (flushTimer) return;
  flushTimer = globalThis.setTimeout(() => {
    flushTimer = 0;
    void flushPending();
  }, FLUSH_DELAY_MS);
};

const flushPending = async () => {
  if (flushInFlight) return;
  if (pendingLines.length === 0) return;
  const store = getStorage();
  if (!store) {
    pendingLines = [];
    return;
  }
  flushInFlight = true;
  try {
    const res = await store.get(LOG_KEY);
    const existing = Array.isArray(res?.[LOG_KEY]) ? (res[LOG_KEY] as string[]) : [];
    const combined = existing.concat(pendingLines);
    pendingLines = [];
    if (combined.length > MAX_LOG_LINES) {
      combined.splice(0, combined.length - MAX_LOG_LINES);
    }
    await store.set({ [LOG_KEY]: combined });
  } finally {
    flushInFlight = false;
    if (pendingLines.length > 0) {
      queueFlush();
    }
  }
};

export const logExtensionEvent = (event: ExtensionLogEvent) => {
  const store = getStorage();
  if (!store) return;
  const line = buildLogLine(event);
  pendingLines.push(line);
  if (pendingLines.length >= FLUSH_BATCH) {
    void flushPending();
    return;
  }
  queueFlush();
};

export const readExtensionLogs = async (tail: number): Promise<ExtensionLogResult> => {
  const store = getStorage();
  if (!store) {
    return { ok: false, lines: [], truncated: false, sizeBytes: 0, mtimeMs: null };
  }
  const res = await store.get(LOG_KEY);
  const allLines = Array.isArray(res?.[LOG_KEY]) ? (res[LOG_KEY] as string[]) : [];
  const total = allLines.length;
  const normalizedTail = Math.max(1, Math.min(5000, Math.round(tail)));
  const lines = total > normalizedTail ? allLines.slice(total - normalizedTail) : allLines;
  const mtimeMs = parseLogMtime(allLines[allLines.length - 1] ?? null);
  const sizeBytes = allLines.reduce((sum, line) => sum + line.length, 0);
  return {
    ok: true,
    lines,
    truncated: total > lines.length,
    sizeBytes,
    mtimeMs,
  };
};
