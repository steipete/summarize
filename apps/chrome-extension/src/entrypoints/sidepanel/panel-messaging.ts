import type { BgToPanel, PanelToBg } from "../../lib/panel-contracts";
import type { SseSlidesData } from "../../lib/runtime-contracts";
import { createPanelPortRuntime } from "./panel-port";
import { patchPanelState } from "./panel-state-store";
import type { PanelState } from "./types";

type PanelPortRuntimeLike = {
  ensure: () => Promise<chrome.runtime.Port | null>;
  send: (message: unknown) => Promise<void>;
};

export function createPanelMessagingRuntime({
  panelState,

  onMessage,
  portRuntime = createPanelPortRuntime({ onMessage }),
  createRequestId = () => `local-slides-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  localSlidesTimeoutMs = 2500,
  setTimer = (callback, delay) => setTimeout(callback, delay),
  clearTimer = (timer) => clearTimeout(timer),
}: {
  panelState: PanelState;

  onMessage: (message: BgToPanel) => void;
  portRuntime?: PanelPortRuntimeLike;
  createRequestId?: () => string;
  localSlidesTimeoutMs?: number;
  setTimer?: (callback: () => void, delay: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
}) {
  const pendingLocalSlidesRequests = new Map<
    string,
    {
      resolve: (slides: SseSlidesData | null) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();

  const sendRaw = (message: PanelToBg) => portRuntime.send(message);

  const send = async (message: PanelToBg) => {
    if (message.type === "panel:summarize") {
      patchPanelState(panelState, "panelSession", { lastAction: "summarize" });
    } else if (message.type === "panel:agent") {
      patchPanelState(panelState, "panelSession", { lastAction: "chat" });
    }
    await sendRaw(message);
  };

  const resolveLocalSlides = async (runId: string): Promise<SseSlidesData | null> => {
    const requestId = createRequestId();
    return await new Promise<SseSlidesData | null>((resolve) => {
      const timer = setTimer(() => {
        pendingLocalSlidesRequests.delete(requestId);
        resolve(null);
      }, localSlidesTimeoutMs);
      pendingLocalSlidesRequests.set(requestId, { resolve, timer });
      void send({ type: "panel:slides-local", requestId, runId });
    });
  };

  const handleLocalSlidesResponse = (message: Extract<BgToPanel, { type: "slides:local" }>) => {
    const pending = pendingLocalSlidesRequests.get(message.requestId);
    if (!pending) return;
    clearTimer(pending.timer);
    pendingLocalSlidesRequests.delete(message.requestId);
    pending.resolve(message.ok ? (message.slides ?? null) : null);
  };

  return {
    ensure: portRuntime.ensure,
    handleLocalSlidesResponse,
    resolveLocalSlides,
    send,
    sendRaw,
  };
}
