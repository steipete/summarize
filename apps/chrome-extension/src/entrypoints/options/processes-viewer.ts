type ProcessStatus = "running" | "exited" | "error";

type ProcessListItem = {
  id: string;
  label: string | null;
  kind: string | null;
  command: string;
  args: string[];
  runId: string | null;
  source: string | null;
  pid: number | null;
  status: ProcessStatus;
  exitCode: number | null;
  signal: string | null;
  error: string | null;
  startedAt: number;
  endedAt: number | null;
  elapsedMs: number;
  progressPercent: number | null;
  progressDetail: string | null;
  statusText: string | null;
  lastLine: string | null;
};

type ProcessListResponse = {
  ok: boolean;
  nowMs: number;
  processes: ProcessListItem[];
};

type ProcessLogLine = { stream: "stdout" | "stderr"; line: string };
type ProcessLogResponse = {
  ok: boolean;
  id: string;
  lines: ProcessLogLine[];
  truncated: boolean;
};

export type ProcessesViewerElements = {
  refreshBtn: HTMLButtonElement;
  autoEl: HTMLInputElement;
  showCompletedEl: HTMLInputElement;
  limitEl: HTMLInputElement;
  streamEl: HTMLSelectElement;
  tailEl: HTMLInputElement;
  metaEl: HTMLDivElement;
  tableEl: HTMLTableElement;
  logsTitleEl: HTMLDivElement;
  logsCopyBtn: HTMLButtonElement;
  logsOutputEl: HTMLPreElement;
};

export type ProcessesViewer = {
  refresh: (opts?: { auto?: boolean }) => Promise<void>;
  startAuto: () => void;
  stopAuto: () => void;
  handleTabActivated: () => void;
  handleTabDeactivated: () => void;
  handleTokenChanged: () => void;
};

export type ProcessesViewerOptions = {
  elements: ProcessesViewerElements;
  getToken: () => string;
  isActive: () => boolean;
  fetchImpl?: typeof fetch;
};

const STATUS_LABELS: Record<ProcessStatus, string> = {
  running: "RUNNING",
  exited: "DONE",
  error: "ERROR",
};

const formatElapsed = (elapsedMs: number): string => {
  if (!Number.isFinite(elapsedMs)) return "";
  const totalSeconds = Math.max(0, Math.round(elapsedMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes <= 0) return `${seconds}s`;
  return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
};

const formatProgress = (item: ProcessListItem): string => {
  if (typeof item.progressPercent === "number") {
    const pct = Math.max(0, Math.min(100, Math.round(item.progressPercent)));
    const detail = item.progressDetail ? ` ${item.progressDetail}` : "";
    return `${pct}%${detail}`;
  }
  if (item.statusText) return item.statusText;
  return "";
};

const normalizeLimit = (value: string) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 80;
  return Math.max(10, Math.min(200, Math.round(parsed)));
};

const normalizeTail = (value: string) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 200;
  return Math.max(20, Math.min(1000, Math.round(parsed)));
};

const buildCommandLabel = (item: ProcessListItem): string => {
  const args = item.args.length > 0 ? ` ${item.args.join(" ")}` : "";
  return `${item.command}${args}`.trim();
};

export function createProcessesViewer(options: ProcessesViewerOptions): ProcessesViewer {
  const { elements, getToken, isActive, fetchImpl } = options;
  const {
    refreshBtn,
    autoEl,
    showCompletedEl,
    limitEl,
    streamEl,
    tailEl,
    metaEl,
    tableEl,
    logsTitleEl,
    logsCopyBtn,
    logsOutputEl,
  } = elements;

  let autoTimer = 0;
  let refreshInFlight = false;
  let needsRefresh = false;
  let selectedId: string | null = null;
  let logsRequestId = 0;
  let logsText = "";

  logsCopyBtn.disabled = true;

  const setMeta = (text: string) => {
    metaEl.textContent = text;
  };

  const clearLogs = () => {
    logsTitleEl.textContent = "Logs";
    logsOutputEl.textContent = "";
    logsText = "";
    logsCopyBtn.disabled = true;
  };

  const renderTable = (items: ProcessListItem[]) => {
    const body = tableEl.tBodies[0];
    const rows = document.createDocumentFragment();
    if (items.length === 0) {
      const row = document.createElement("tr");
      const cell = document.createElement("td");
      cell.colSpan = 7;
      cell.textContent = "No active processes.";
      cell.className = "processEmpty";
      row.append(cell);
      rows.append(row);
      body.replaceChildren(rows);
      return;
    }
    for (const item of items) {
      const row = document.createElement("tr");
      row.dataset.processId = item.id;
      if (selectedId === item.id) row.classList.add("selected");

      const toolCell = document.createElement("td");
      toolCell.textContent = item.label || item.kind || item.command;

      const pidCell = document.createElement("td");
      pidCell.textContent = item.pid ? String(item.pid) : "—";

      const statusCell = document.createElement("td");
      statusCell.textContent = STATUS_LABELS[item.status];
      statusCell.className = `status ${item.status}`;

      const elapsedCell = document.createElement("td");
      elapsedCell.textContent = formatElapsed(item.elapsedMs);

      const progressCell = document.createElement("td");
      progressCell.textContent = formatProgress(item) || "—";

      const runCell = document.createElement("td");
      runCell.textContent = item.runId ? item.runId.slice(0, 8) : "—";

      const cmdCell = document.createElement("td");
      const cmd = buildCommandLabel(item);
      cmdCell.textContent = cmd.length > 120 ? `${cmd.slice(0, 120)}…` : cmd;
      cmdCell.title = cmd;
      cmdCell.className = "command";

      row.append(toolCell, pidCell, statusCell, elapsedCell, progressCell, runCell, cmdCell);
      rows.append(row);
    }
    body.replaceChildren(rows);
  };

  const refreshLogs = async () => {
    const requestId = ++logsRequestId;
    const requestedId = selectedId;
    const isCurrentRequest = () => requestId === logsRequestId && selectedId === requestedId;
    const clearLogsIfCurrent = () => {
      if (isCurrentRequest()) clearLogs();
    };
    if (!requestedId) {
      clearLogs();
      return;
    }
    const token = getToken().trim();
    if (!token) {
      clearLogs();
      return;
    }
    const tail = normalizeTail(tailEl.value);
    tailEl.value = String(tail);
    const stream =
      streamEl.value === "stdout" || streamEl.value === "stderr" ? streamEl.value : "merged";
    try {
      const url = new URL(`http://127.0.0.1:8787/v1/processes/${requestedId}/logs`);
      url.searchParams.set("tail", String(tail));
      url.searchParams.set("stream", stream);
      const res = await (fetchImpl ?? fetch)(url.toString(), {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!isCurrentRequest()) return;
      if (!res.ok) {
        clearLogs();
        return;
      }
      const json = (await res.json()) as ProcessLogResponse;
      if (!isCurrentRequest()) return;
      if (!json?.ok || json.id !== requestedId || !Array.isArray(json.lines)) {
        clearLogs();
        return;
      }
      logsTitleEl.textContent = `Logs · ${requestedId.slice(0, 8)}`;
      logsText = json.lines
        .map((line) => `${line.stream === "stderr" ? "err" : "out"} | ${line.line}`)
        .join("\n");
      logsOutputEl.textContent = logsText;
      logsCopyBtn.disabled = logsText.trim().length === 0;
    } catch {
      clearLogsIfCurrent();
    }
  };

  const refresh = async (opts: { auto?: boolean } = {}) => {
    if (refreshInFlight) {
      needsRefresh = true;
      return;
    }
    if (!isActive()) return;
    const token = getToken().trim();
    if (!token) {
      setMeta("Add token to load processes.");
      renderTable([]);
      clearLogs();
      needsRefresh = true;
      return;
    }
    refreshInFlight = true;
    needsRefresh = false;
    const limit = normalizeLimit(limitEl.value);
    limitEl.value = String(limit);
    if (!opts.auto) {
      setMeta("Loading processes…");
    }
    try {
      const url = new URL("http://127.0.0.1:8787/v1/processes");
      url.searchParams.set("includeCompleted", showCompletedEl.checked ? "true" : "false");
      url.searchParams.set("limit", String(limit));
      const res = await (fetchImpl ?? fetch)(url.toString(), {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        const message = body?.error ? body.error : `${res.status} ${res.statusText}`;
        setMeta(message);
        renderTable([]);
        clearLogs();
        return;
      }
      const json = (await res.json()) as ProcessListResponse;
      if (!json?.ok || !Array.isArray(json.processes)) {
        setMeta("No process data.");
        renderTable([]);
        clearLogs();
        return;
      }
      renderTable(json.processes);
      setMeta(`${json.processes.length} processes`);
      if (selectedId && !json.processes.some((item) => item.id === selectedId)) {
        selectedId = null;
        clearLogs();
      } else if (selectedId) {
        await refreshLogs();
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setMeta(message);
      renderTable([]);
      clearLogs();
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

  autoEl.addEventListener("change", () => {
    if (autoEl.checked) startAuto();
    else stopAuto();
  });

  showCompletedEl.addEventListener("change", () => {
    void refresh();
  });

  limitEl.addEventListener("change", () => {
    void refresh();
  });

  tailEl.addEventListener("change", () => {
    void refreshLogs();
  });

  streamEl.addEventListener("change", () => {
    void refreshLogs();
  });

  const copyLogs = async () => {
    if (!logsText.trim()) return;
    try {
      await navigator.clipboard.writeText(logsText);
      return;
    } catch {
      // fallback
    }
    const selection = window.getSelection();
    if (!selection) return;
    const range = document.createRange();
    range.selectNodeContents(logsOutputEl);
    selection.removeAllRanges();
    selection.addRange(range);
    document.execCommand("copy");
    selection.removeAllRanges();
  };

  logsCopyBtn.addEventListener("click", () => {
    void copyLogs();
  });

  tableEl.addEventListener("click", (event) => {
    const target = event.target as HTMLElement | null;
    const row = target?.closest("tr[data-process-id]") as HTMLTableRowElement | null;
    if (!row) return;
    const id = row.dataset.processId;
    if (!id) return;
    selectedId = id;
    for (const item of tableEl.tBodies[0].querySelectorAll("tr")) {
      item.classList.toggle("selected", item === row);
    }
    void refreshLogs();
  });

  return {
    refresh,
    startAuto,
    stopAuto,
    handleTabActivated,
    handleTabDeactivated,
    handleTokenChanged,
  };
}
