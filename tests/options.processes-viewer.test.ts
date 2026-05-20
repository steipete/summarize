// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import {
  createProcessesViewer,
  type ProcessesViewerElements,
} from "../apps/chrome-extension/src/entrypoints/options/processes-viewer.js";

const jsonResponse = (body: unknown) =>
  new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });

const createDeferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

const flushAsyncWork = () => new Promise<void>((resolve) => window.setTimeout(resolve, 0));

const createElements = (): ProcessesViewerElements => {
  const tableEl = document.createElement("table");
  tableEl.append(document.createElement("tbody"));
  const streamEl = document.createElement("select");
  for (const value of ["merged", "stdout", "stderr"]) {
    const option = document.createElement("option");
    option.value = value;
    streamEl.append(option);
  }
  streamEl.value = "merged";
  return {
    refreshBtn: document.createElement("button"),
    autoEl: document.createElement("input"),
    showCompletedEl: document.createElement("input"),
    limitEl: Object.assign(document.createElement("input"), { value: "80" }),
    streamEl,
    tailEl: Object.assign(document.createElement("input"), { value: "200" }),
    metaEl: document.createElement("div"),
    tableEl,
    logsTitleEl: document.createElement("div"),
    logsCopyBtn: document.createElement("button"),
    logsOutputEl: document.createElement("pre"),
  };
};

const processItem = (id: string) => ({
  id,
  label: id,
  kind: "summary",
  command: "summarize",
  args: [],
  runId: null,
  source: null,
  pid: 123,
  status: "running" as const,
  exitCode: null,
  signal: null,
  error: null,
  startedAt: 0,
  endedAt: null,
  elapsedMs: 1000,
  progressPercent: null,
  progressDetail: null,
  statusText: null,
  lastLine: null,
});

describe("options processes viewer", () => {
  it("ignores stale log responses after selecting another process", async () => {
    const elements = createElements();
    const alphaLogs = createDeferred<Response>();
    const bravoLogs = createDeferred<Response>();
    const fetchImpl = async (input: string | URL | Request): Promise<Response> => {
      const url = new URL(String(input));
      if (url.pathname === "/v1/processes") {
        return jsonResponse({
          ok: true,
          nowMs: 0,
          processes: [processItem("alpha-123456"), processItem("bravo-123456")],
        });
      }
      if (url.pathname.includes("alpha-123456")) return alphaLogs.promise;
      if (url.pathname.includes("bravo-123456")) return bravoLogs.promise;
      throw new Error(`unexpected request: ${url.pathname}`);
    };

    const viewer = createProcessesViewer({
      elements,
      getToken: () => "token",
      isActive: () => true,
      fetchImpl,
    });

    await viewer.refresh();
    const rows =
      elements.tableEl.tBodies[0].querySelectorAll<HTMLTableRowElement>("tr[data-process-id]");
    rows[0]?.click();
    rows[1]?.click();

    bravoLogs.resolve(
      jsonResponse({
        ok: true,
        id: "bravo-123456",
        lines: [{ stream: "stdout", line: "bravo output" }],
        truncated: false,
      }),
    );
    await flushAsyncWork();

    alphaLogs.resolve(
      jsonResponse({
        ok: true,
        id: "alpha-123456",
        lines: [{ stream: "stdout", line: "alpha output" }],
        truncated: false,
      }),
    );
    await flushAsyncWork();

    expect(elements.logsTitleEl.textContent).toBe("Logs · bravo-12");
    expect(elements.logsOutputEl.textContent).toBe("out | bravo output");
    expect(elements.logsCopyBtn.disabled).toBe(false);
  });
});
