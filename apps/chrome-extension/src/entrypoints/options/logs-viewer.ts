import { daemonFetch } from "../../lib/daemon-fetch";
import { getDaemonOrigin } from "../../lib/daemon-url";
import { readExtensionLogs } from "../../lib/extension-logs";

type LogLevel = "info" | "warn" | "error" | "verbose";

type LogEntry = {
  raw: string;
  level: LogLevel;
  time: string;
  event: string;
  details: string;
  isJson: boolean;
};

export type LogsViewerElements = {
  sourceEl: HTMLSelectElement;
  tailEl: HTMLInputElement;
  refreshBtn: HTMLButtonElement;
  autoEl: HTMLInputElement;
  outputEl: HTMLDivElement;
  rawEl: HTMLPreElement;
  tableEl: HTMLTableElement;
  parsedEl: HTMLInputElement;
  metaEl: HTMLDivElement;
  levelInputs: HTMLInputElement[];
};

export type LogsViewer = {
  refresh: (opts?: { auto?: boolean }) => Promise<void>;
  render: () => void;
  startAuto: () => void;
  stopAuto: () => void;
  handleTabActivated: () => void;
  handleTabDeactivated: () => void;
  handleTokenChanged: () => void;
};

export type LogsViewerOptions = {
  elements: LogsViewerElements;
  getToken: () => string;
  isActive: () => boolean;
  fetchImpl?: typeof fetch;
};

const LOG_LEVELS: LogLevel[] = ["info", "warn", "error", "verbose"];
const LOG_LEVEL_LABELS: Record<LogLevel, string> = {
  info: "INFO",
  warn: "WARN",
  error: "ERROR",
  verbose: "VERBOSE",
};
const LOG_LEVEL_ALIASES: Record<string, LogLevel> = {
  info: "info",
  warn: "warn",
  warning: "warn",
  error: "error",
  err: "error",
  debug: "verbose",
  trace: "verbose",
  verbose: "verbose",
};
const LOG_DETAIL_IGNORE = new Set([
  "date",
  "event",
  "level",
  "loglevel",
  "loglevelname",
  "meta",
  "name",
  "hostname",
  "parentNames",
  "pid",
  "runtime",
  "runtimeVersion",
]);

const formatBytes = (bytes: number): string => {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  const digits = value < 10 && unitIndex > 0 ? 1 : 0;
  return `${value.toFixed(digits)} ${units[unitIndex]}`;
};

const formatRelativeTime = (timeMs: number): string => {
  if (!Number.isFinite(timeMs)) return "";
  const diffMs = Date.now() - timeMs;
  if (!Number.isFinite(diffMs)) return "";
  const diffSeconds = Math.max(0, Math.round(diffMs / 1000));
  if (diffSeconds < 10) return "just now";
  if (diffSeconds < 60) return `${diffSeconds}s ago`;
  const diffMinutes = Math.round(diffSeconds / 60);
  if (diffMinutes < 60) return `${diffMinutes}m ago`;
  const diffHours = Math.round(diffMinutes / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  const diffDays = Math.round(diffHours / 24);
  return `${diffDays}d ago`;
};

const formatLogTime = (value: unknown): string => {
  if (typeof value !== "string") return "";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "";
  return parsed.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
};

const normalizeLogLevel = (value: unknown): LogLevel => {
  const raw = typeof value === "string" ? value.toLowerCase().trim() : "";
  return LOG_LEVEL_ALIASES[raw] ?? "info";
};

const formatDetailValue = (value: unknown): string => {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    const preview = value.slice(0, 3).map((item) => String(item));
    return value.length > 3 ? `${preview.join(", ")} …` : preview.join(", ");
  }
  return "";
};

const buildLogDetails = (obj: Record<string, unknown>): string => {
  const details: string[] = [];
  for (const [key, value] of Object.entries(obj)) {
    const normalized = key.toLowerCase();
    if (LOG_DETAIL_IGNORE.has(normalized)) continue;
    if (value == null) continue;
    if (typeof value === "object" && !Array.isArray(value)) continue;
    const formatted = formatDetailValue(value);
    if (!formatted) continue;
    details.push(`${key}=${formatted}`);
  }
  return details.join(" · ");
};

const parseLogLine = (line: string): LogEntry | null => {
  const trimmed = line.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    try {
      const obj = JSON.parse(trimmed) as Record<string, unknown>;
      const level = normalizeLogLevel(obj.logLevelName ?? obj.level ?? obj.logLevel) ?? "info";
      return {
        raw: trimmed,
        level,
        time: formatLogTime(obj.date),
        event: typeof obj.event === "string" ? obj.event : "",
        details: buildLogDetails(obj),
        isJson: true,
      };
    } catch {
      // fall through to raw handling
    }
  }
  const lower = trimmed.toLowerCase();
  const level =
    lower.includes("error") || lower.startsWith("err")
      ? "error"
      : lower.includes("warn")
        ? "warn"
        : "info";
  return {
    raw: trimmed,
    level,
    time: "",
    event: "",
    details: "",
    isJson: false,
  };
};

const isAtBottom = (el: HTMLElement) => el.scrollTop + el.clientHeight >= el.scrollHeight - 6;

const scrollToBottom = (el: HTMLElement) => {
  el.scrollTop = el.scrollHeight;
};

const normalizeTailCount = (value: string) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 800;
  return Math.max(100, Math.min(5000, Math.round(parsed)));
};

export function createLogsViewer(options: LogsViewerOptions): LogsViewer {
  const { elements, getToken, isActive, fetchImpl } = options;
  const {
    sourceEl,
    tailEl,
    refreshBtn,
    autoEl,
    outputEl,
    rawEl,
    tableEl,
    parsedEl,
    metaEl,
    levelInputs,
  } = elements;

  let autoTimer = 0;
  let refreshInFlight = false;
  let needsRefresh = false;
  let lines: string[] = [];
  let entries: LogEntry[] = [];

  const setMeta = (text: string) => {
    metaEl.textContent = text;
    metaEl.title = "";
  };

  const setMetaInfo = (info: {
    sizeBytes?: number;
    mtimeMs?: number | null;
    truncated?: boolean;
    warning?: string;
  }) => {
    const summaryParts: string[] = [];
    if (typeof info.sizeBytes === "number") {
      summaryParts.push(`size ${formatBytes(info.sizeBytes)}`);
    }
    if (typeof info.mtimeMs === "number") {
      const relative = formatRelativeTime(info.mtimeMs);
      if (relative) summaryParts.push(`updated ${relative}`);
      metaEl.title = new Date(info.mtimeMs).toLocaleString();
    } else {
      metaEl.title = "";
    }
    if (info.truncated) summaryParts.push("tail truncated");
    if (info.warning) summaryParts.push(info.warning);
    setMeta(summaryParts.join(" · "));
  };

  const render = () => {
    const stickToBottom = isAtBottom(outputEl);
    const parsedEnabled = parsedEl.checked;
    const enabledLevels = new Set(
      levelInputs
        .filter((input) => input.checked)
        .map((input) => input.dataset.logLevel)
        .filter((level): level is LogLevel => Boolean(level)),
    );
    const activeLevels = enabledLevels.size > 0 ? enabledLevels : new Set(LOG_LEVELS);

    if (!parsedEnabled) {
      tableEl.hidden = true;
      rawEl.hidden = false;
      rawEl.textContent = lines.join("\n");
      if (stickToBottom) scrollToBottom(outputEl);
      return;
    }

    tableEl.hidden = false;
    rawEl.hidden = true;
    const body = tableEl.tBodies[0];
    const rows = document.createDocumentFragment();
    let rendered = 0;
    for (const entry of entries) {
      if (!activeLevels.has(entry.level)) continue;
      const row = document.createElement("tr");
      const timeCell = document.createElement("td");
      timeCell.textContent = entry.time || "—";
      const levelCell = document.createElement("td");
      levelCell.textContent = LOG_LEVEL_LABELS[entry.level];
      levelCell.className = `level ${entry.level}`;
      const eventCell = document.createElement("td");
      eventCell.textContent = entry.event || (entry.isJson ? "log" : "raw");
      const detailCell = document.createElement("td");
      detailCell.textContent = entry.details || entry.raw;
      detailCell.className = "details";
      row.append(timeCell, levelCell, eventCell, detailCell);
      rows.append(row);
      rendered += 1;
    }
    if (rendered === 0) {
      const row = document.createElement("tr");
      const cell = document.createElement("td");
      cell.colSpan = 4;
      cell.textContent = "No matching log entries.";
      cell.className = "details";
      row.append(cell);
      rows.append(row);
    }
    body.replaceChildren(rows);
    if (stickToBottom) scrollToBottom(outputEl);
  };

  const setLines = (nextLines: string[]) => {
    lines = nextLines;
    entries = nextLines
      .map((line) => parseLogLine(line))
      .filter((entry): entry is LogEntry => !!entry);
    render();
  };

  const refresh = async (opts: { auto?: boolean } = {}) => {
    if (refreshInFlight) {
      needsRefresh = true;
      return;
    }
    if (!isActive()) return;
    const source = sourceEl.value.trim() || "daemon";
    const isExtensionSource = source === "extension";
    const token = getToken().trim();
    if (!isExtensionSource && !token) {
      setMeta("Add token to load daemon logs.");
      setLines([]);
      needsRefresh = true;
      return;
    }
    refreshInFlight = true;
    needsRefresh = false;
    const tail = normalizeTailCount(tailEl.value);
    tailEl.value = String(tail);
    if (!opts.auto) {
      setMeta("Loading logs…");
    }
    try {
      if (isExtensionSource) {
        const result = await readExtensionLogs(tail);
        if (!result.ok) {
          setMeta("Extension logs unavailable.");
          setLines([]);
          return;
        }
        if (!result.lines.length) {
          setMeta("No logs returned.");
          setLines([]);
          return;
        }
        setMetaInfo(result);
        setLines(result.lines);
        return;
      }
      const origin = await getDaemonOrigin();

      const url = new URL(`${origin}/v1/logs`);
      url.searchParams.set("source", source);
      url.searchParams.set("tail", String(tail));
      const res = await (fetchImpl ?? daemonFetch)(url.toString(), {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        const message = body?.error ? body.error : `${res.status} ${res.statusText}`;
        setMeta(message);
        setLines([]);
        return;
      }
      const json = (await res.json()) as {
        ok: boolean;
        lines?: string[];
        truncated?: boolean;
        sizeBytes?: number;
        mtimeMs?: number;
        warning?: string;
      };
      if (!json?.ok || !Array.isArray(json.lines)) {
        setMeta("No logs returned.");
        setLines([]);
        return;
      }
      setMetaInfo(json);
      setLines(json.lines);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setMeta(message);
      setLines([]);
    } finally {
      refreshInFlight = false;
      if (needsRefresh && isActive()) {
        needsRefresh = false;
        void refresh({ auto: true });
      }
    }
  };

  const stopAuto = () => {
    if (autoTimer) window.clearInterval(autoTimer);
    autoTimer = 0;
  };

  const startAuto = () => {
    stopAuto();
    autoTimer = window.setInterval(() => {
      if (!isActive()) return;
      void refresh({ auto: true });
    }, 2000);
  };

  const handleTabActivated = () => {
    void refresh();
    if (autoEl.checked) startAuto();
  };

  const handleTabDeactivated = () => {
    stopAuto();
  };

  const handleTokenChanged = () => {
    if (isActive()) {
      void refresh();
    } else {
      needsRefresh = true;
    }
  };

  refreshBtn.addEventListener("click", () => {
    void refresh();
  });

  return {
    refresh,
    render,
    startAuto,
    stopAuto,
    handleTabActivated,
    handleTabDeactivated,
    handleTokenChanged,
  };
}
