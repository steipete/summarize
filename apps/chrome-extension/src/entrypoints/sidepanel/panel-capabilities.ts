import type { PanelState } from "./types";

export function isPanelChatAvailable(panelState: PanelState): boolean {
  return panelState.panelSession.chatEnabled && panelState.panelSession.daemonFeaturesAvailable;
}

export function isPanelAutomationAvailable(panelState: PanelState): boolean {
  return panelState.panelSession.automationEnabled && isPanelChatAvailable(panelState);
}
