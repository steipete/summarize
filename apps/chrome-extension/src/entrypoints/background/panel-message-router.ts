import { isOptionsTab, type OptionsTab } from "../../lib/options-tabs";
import type { PanelToBg } from "../../lib/panel-contracts";

type RouterSession = {
  panelOpen: boolean;
  panelLastPingAt: number;
  lastSummarizedUrl: string | null;
  inflightUrl: string | null;
};

type PanelMessageHandlers<Session> = {
  ready(session: Session): void;
  closed(session: Session): void;
  summarize(
    session: Session,
    reason: "manual" | "refresh",
    options: { refresh: boolean; inputMode?: "page" | "video" },
  ): void;
  storeCache(session: Session, message: Extract<PanelToBg, { type: "panel:cache" }>): void;
  getCache(session: Session, message: Extract<PanelToBg, { type: "panel:get-cache" }>): void;
  agent(session: Session, message: Extract<PanelToBg, { type: "panel:agent" }>): void;
  chatHistory(session: Session, message: Extract<PanelToBg, { type: "panel:chat-history" }>): void;
  ping(session: Session): void;
  setAuto(session: Session, value: boolean): void;
  setLength(session: Session, value: string): void;
  slidesContext(
    session: Session,
    message: Extract<PanelToBg, { type: "panel:slides-context" }>,
  ): void;
  slidesLocal(session: Session, message: Extract<PanelToBg, { type: "panel:slides-local" }>): void;
  slidesCapture(
    session: Session,
    message: Extract<PanelToBg, { type: "panel:slides-capture" }>,
  ): void;
  openOptions(options?: { tab?: OptionsTab }): void;
  seek(session: Session, seconds: number): void;
};

export function createPanelMessageRouter<Session extends RouterSession>(
  handlers: PanelMessageHandlers<Session>,
) {
  return (session: Session, raw: unknown) => {
    if (!isPanelMessage(raw)) return;
    if (raw.type !== "panel:closed") {
      session.panelOpen = true;
    }
    if (raw.type === "panel:ping") session.panelLastPingAt = Date.now();

    switch (raw.type) {
      case "panel:ready":
        handlers.ready(session);
        break;
      case "panel:closed":
        handlers.closed(session);
        break;
      case "panel:summarize": {
        const refresh = Boolean(raw.refresh);
        handlers.summarize(session, refresh ? "refresh" : "manual", {
          refresh,
          inputMode: raw.inputMode,
        });
        break;
      }
      case "panel:cache":
        handlers.storeCache(session, raw);
        break;
      case "panel:get-cache":
        handlers.getCache(session, raw);
        break;
      case "panel:agent":
        handlers.agent(session, raw);
        break;
      case "panel:chat-history":
        handlers.chatHistory(session, raw);
        break;
      case "panel:ping":
        handlers.ping(session);
        break;
      case "panel:rememberUrl":
        session.lastSummarizedUrl = raw.url;
        session.inflightUrl = null;
        break;
      case "panel:setAuto":
        handlers.setAuto(session, raw.value);
        break;
      case "panel:setLength":
        handlers.setLength(session, raw.value);
        break;
      case "panel:slides-context":
        handlers.slidesContext(session, raw);
        break;
      case "panel:slides-local":
        handlers.slidesLocal(session, raw);
        break;
      case "panel:slides-capture":
        handlers.slidesCapture(session, raw);
        break;
      case "panel:openOptions":
        handlers.openOptions(isOptionsTab(raw.tab) ? { tab: raw.tab } : undefined);
        break;
      case "panel:seek":
        if (Number.isFinite(raw.seconds) && raw.seconds >= 0) {
          handlers.seek(session, Math.floor(raw.seconds));
        }
        break;
    }
  };
}

function isPanelMessage(raw: unknown): raw is PanelToBg {
  return Boolean(
    raw && typeof raw === "object" && typeof (raw as { type?: unknown }).type === "string",
  );
}
