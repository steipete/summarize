import { logExtensionEvent } from "../../lib/extension-logs";
import { resolvePanelState } from "./panel-state";
import { summarizeActiveTab as runPanelSummarize } from "./panel-summarize";

export function createBackgroundPanelRuntime<
  Session extends {
    windowId: number;
    port: chrome.runtime.Port;
    activeSummaryRun: Parameters<typeof runPanelSummarize>[0]["session"]["activeSummaryRun"];
    daemonRecovery: { clearPending: () => void };
  },
>(options: {
  panelSessionStore: {
    isPanelOpen: (session: Session) => boolean;
  } & Record<string, unknown>;
  loadSettings: typeof import("../../lib/settings").loadSettings;
  getActiveTab: typeof import("./panel-utils").getActiveTab;
  daemonHealth: typeof import("./daemon-client").daemonHealth;
  daemonPing: typeof import("./daemon-client").daemonPing;
  canSummarizeUrl: typeof import("./content-script-bridge").canSummarizeUrl;
  urlsMatch: typeof import("./panel-utils").urlsMatch;
  primeMediaHint: typeof import("./extract-cache").primeMediaHint;
  extractFromTab: typeof import("./content-script-bridge").extractFromTab;
  buildSummarizeRequestBody: typeof import("../lib/daemon-payload").buildSummarizeRequestBody;
  friendlyFetchError: typeof import("./daemon-client").friendlyFetchError;
  isDaemonUnreachableError: typeof import("../../lib/daemon-recovery").isDaemonUnreachableError;
  fetchImpl: typeof fetch;
  resolveLogLevel: (event: string) => "verbose" | "warn" | "error";
  transcribeMediaLocally?: Parameters<typeof runPanelSummarize>[0]["transcribeMediaLocally"];
  transcribeYouTubeLocally?: Parameters<typeof runPanelSummarize>[0]["transcribeYouTubeLocally"];
}) {
  const {
    panelSessionStore,
    loadSettings,
    getActiveTab,
    daemonHealth,
    daemonPing,
    canSummarizeUrl,
    urlsMatch,
    primeMediaHint,
    extractFromTab,
    buildSummarizeRequestBody,
    friendlyFetchError,
    isDaemonUnreachableError,
    fetchImpl,
    resolveLogLevel,
    transcribeMediaLocally,
    transcribeYouTubeLocally,
  } = options;

  const send = (session: Session, msg: unknown) => {
    if (!panelSessionStore.isPanelOpen(session)) return;
    try {
      session.port.postMessage(msg);
    } catch {
      // ignore
    }
  };

  const sendStatus = (session: Session, status: string) => {
    send(session, { type: "ui:status", status });
  };

  const emitState = async (
    session: Session,
    status: string,
    opts?: { checkRecovery?: boolean },
  ) => {
    const next = await resolvePanelState({
      session,
      status,
      checkRecovery: opts?.checkRecovery,
      loadSettings,
      getActiveTab,
      daemonHealth,
      daemonPing,
      panelSessionStore,
      urlsMatch,
      canSummarizeUrl,
    });
    send(session, { type: "ui:state", state: next.state });

    if (next.shouldRecover) {
      void summarizeActiveTab(session, "daemon-recovered");
      return;
    }

    if (next.shouldClearPending) {
      session.daemonRecovery.clearPending();
    }

    if (next.shouldPrimeMedia) {
      void primeMediaHint({
        session,
        ...next.shouldPrimeMedia,
        panelSessionStore,
        urlsMatch,
        extractFromTab,
        emitState: (currentSession, nextStatus) => {
          void emitState(currentSession, nextStatus);
        },
      });
    }
  };

  const summarizeActiveTab = (
    session: Session,
    reason: string,
    opts?: { refresh?: boolean; inputMode?: "page" | "video" },
  ) =>
    runPanelSummarize({
      session,
      reason,
      opts,
      loadSettings,
      emitState: (currentSession, nextStatus) => emitState(currentSession, nextStatus),
      getActiveTab,
      canSummarizeUrl,
      panelSessionStore,
      sendStatus: (status) => sendStatus(session, status),
      send: (msg) => {
        send(session, msg);
      },
      fetchImpl,
      extractFromTab,
      urlsMatch,
      buildSummarizeRequestBody,
      friendlyFetchError,
      isDaemonUnreachableError,
      transcribeMediaLocally,
      transcribeYouTubeLocally,
      logPanel: (event, detail) => {
        void (async () => {
          const settings = await loadSettings();
          if (!settings.extendedLogging) return;
          const payload = detail ? { event, windowId: session.windowId, ...detail } : { event };
          const detailPayload = detail
            ? { windowId: session.windowId, ...detail }
            : { windowId: session.windowId };
          logExtensionEvent({
            event,
            detail: detailPayload,
            scope: "panel:bg",
            level: resolveLogLevel(event),
          });
          console.debug("[summarize][panel:bg]", payload);
        })();
      },
    });

  return { send, sendStatus, emitState, summarizeActiveTab };
}
