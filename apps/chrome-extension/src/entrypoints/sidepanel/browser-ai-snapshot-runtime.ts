import { buildBrowserAiSummaryMarkdown } from "../../lib/browser-summary";
import { logExtensionEvent } from "../../lib/extension-logs";
import type { BgToPanel } from "../../lib/panel-contracts";
import type { BrowserAiRequestKey } from "./browser-ai-summary-runtime";
import { panelUrlsMatch } from "./session-policy";
import type { PanelState } from "./types";

type BrowserSummarySnapshot = Extract<BgToPanel, { type: "run:snapshot" }>;

export function createBrowserAiSnapshotRuntime(options: {
  panelState: PanelState;

  browserAi: {
    cancel: (requestKey?: BrowserAiRequestKey) => void;
    summarize: (options: {
      input: NonNullable<BrowserSummarySnapshot["browserAi"]>;
      context?: string;
    }) => Promise<string | null>;
  };
  renderMarkdown: (markdown: string) => void;
}) {
  const enhance = (snapshot: BrowserSummarySnapshot) => {
    if (!snapshot.browserAi) {
      options.browserAi.cancel("summary");
      return;
    }
    const browserAi = snapshot.browserAi;
    const runId = snapshot.run.id;
    const runUrl = snapshot.run.url;
    void options.browserAi
      .summarize({
        input: browserAi,
        context: snapshot.run.title
          ? `Summarize the page or media titled "${snapshot.run.title}".`
          : undefined,
      })
      .then((summary) => {
        if (!summary) return;
        if (options.panelState.runId !== runId) {
          logExtensionEvent({
            event: "browser-ai:snapshot-discarded",
            level: "verbose",
            scope: "sidepanel",
            detail: { reason: "run-changed" },
          });
          return;
        }
        const currentUrl = options.panelState.currentSource?.url;
        if (!currentUrl || !panelUrlsMatch(currentUrl, runUrl)) {
          logExtensionEvent({
            event: "browser-ai:snapshot-discarded",
            level: "verbose",
            scope: "sidepanel",
            detail: { reason: "url-changed", currentUrl, runUrl },
          });
          return;
        }
        options.panelState.lastMeta = {
          ...options.panelState.lastMeta,
          model: "Gemini Nano",
          modelLabel: "Gemini Nano",
        };
        options.renderMarkdown(
          buildBrowserAiSummaryMarkdown({
            title: snapshot.run.title,
            summary,
            keyMoments: browserAi.keyMoments,
          }),
        );
      });
  };

  return {
    cancel: () => options.browserAi.cancel("summary"),
    enhance,
  };
}
