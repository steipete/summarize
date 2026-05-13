type RuntimeMessageHandler = (
  raw: unknown,
  sender: chrome.runtime.MessageSender,
  sendResponse: (response?: unknown) => void,
) => boolean | undefined;

type SessionWithNavAt = { lastNavAt: number };

type PanelSessionStoreLike<Session extends SessionWithNavAt> = {
  registerPanelSession: (windowId: number, port: chrome.runtime.Port) => Session;
  deletePanelSession: (windowId: number) => void;
  getPanelSession: (windowId: number) => Session | null;
  getPanelSessions: () => Iterable<Session>;
  clearCachedExtractsForWindow: (windowId: number) => Promise<void>;
  clearTab: (tabId: number) => void;
};

export function bindBackgroundListeners<Session extends SessionWithNavAt>(options: {
  panelSessionStore: PanelSessionStoreLike<Session>;
  handlePanelMessage: (session: Session, raw: unknown) => void;
  onPanelDisconnect: (session: Session, port: chrome.runtime.Port, windowId: number) => void;
  runtimeActionsHandler: RuntimeMessageHandler;
  hoverRuntimeHandler: RuntimeMessageHandler;
  emitState: (session: Session, status: string) => void;
  summarizeActiveTab: (session: Session, reason: string) => void;
  onTabRemoved: (tabId: number) => void;
}) {
  const {
    panelSessionStore,
    handlePanelMessage,
    onPanelDisconnect,
    runtimeActionsHandler,
    hoverRuntimeHandler,
    emitState,
    summarizeActiveTab,
    onTabRemoved,
  } = options;

  chrome.runtime.onConnect.addListener((port) => {
    if (!port.name.startsWith("sidepanel:")) return;
    const windowIdRaw = port.name.split(":")[1] ?? "";
    const windowId = Number.parseInt(windowIdRaw, 10);
    if (!Number.isFinite(windowId)) return;
    const session = panelSessionStore.registerPanelSession(windowId, port);
    port.onMessage.addListener((msg) => handlePanelMessage(session, msg));
    port.onDisconnect.addListener(() => {
      onPanelDisconnect(session, port, windowId);
    });
  });

  chrome.runtime.onMessage.addListener((raw, sender, sendResponse): boolean | undefined => {
    return (
      runtimeActionsHandler(raw, sender, sendResponse) ??
      hoverRuntimeHandler(raw, sender, sendResponse)
    );
  });

  chrome.runtime.onUserScriptMessage?.addListener(
    (raw, sender, sendResponse): boolean | undefined =>
      runtimeActionsHandler(raw, sender, sendResponse),
  );

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local") return;
    if (!changes.settings) return;
    for (const session of panelSessionStore.getPanelSessions()) {
      void emitState(session, "");
    }
  });

  chrome.webNavigation.onHistoryStateUpdated.addListener((details) => {
    void (async () => {
      const tab = await chrome.tabs.get(details.tabId).catch(() => null);
      const windowId = tab?.windowId;
      if (typeof windowId !== "number") return;
      const session = panelSessionStore.getPanelSession(windowId);
      if (!session) return;
      const now = Date.now();
      if (now - session.lastNavAt < 700) return;
      session.lastNavAt = now;
      void emitState(session, "");
      void summarizeActiveTab(session, "spa-nav");
    })();
  });

  chrome.tabs.onActivated.addListener((info) => {
    const session = panelSessionStore.getPanelSession(info.windowId);
    if (!session) return;
    void emitState(session, "");
    void summarizeActiveTab(session, "tab-activated");
  });

  chrome.tabs.onUpdated.addListener((_tabId, changeInfo, tab) => {
    const windowId = tab?.windowId;
    if (typeof windowId !== "number") return;
    const session = panelSessionStore.getPanelSession(windowId);
    if (!session) return;
    if (typeof changeInfo.title === "string" || typeof changeInfo.url === "string") {
      void emitState(session, "");
    }
    if (typeof changeInfo.url === "string") {
      void summarizeActiveTab(session, "tab-url-change");
    }
    if (changeInfo.status === "complete") {
      void emitState(session, "");
      void summarizeActiveTab(session, "tab-updated");
    }
  });

  chrome.tabs.onRemoved.addListener((tabId) => {
    panelSessionStore.clearTab(tabId);
    onTabRemoved(tabId);
  });
}
