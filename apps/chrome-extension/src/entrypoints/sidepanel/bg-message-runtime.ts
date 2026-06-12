import type { BgToPanel, RunStart, UiState } from "../../lib/panel-contracts";
import type { PanelStateAction } from "./panel-state-store";
import {
  normalizePanelUrl,
  shouldAcceptRunForCurrentPage,
  shouldAcceptSlidesForCurrentPage,
} from "./session-policy";

export function handleSidepanelBgMessage(options: {
  msg: BgToPanel;
  applyUiState: (state: UiState) => void;
  setStatus: (text: string) => void;
  isStreaming: () => boolean;
  handleRunError: (message: string) => void;
  handleSlidesRun: (msg: Extract<BgToPanel, { type: "slides:run" }>) => void;
  handleSlidesLocal: (msg: Extract<BgToPanel, { type: "slides:local" }>) => void;
  handleSlidesContext: (msg: Extract<BgToPanel, { type: "slides:context" }>) => void;
  handleUiCache: (msg: Extract<BgToPanel, { type: "ui:cache" }>) => void;
  handleCacheCleared: () => void;
  handleRunStart: (run: RunStart) => void;
  handleRunSnapshot: (payload: Extract<BgToPanel, { type: "run:snapshot" }>) => void;
  handleChatHistory: (msg: Extract<BgToPanel, { type: "chat:history" }>) => void;
  handleAgentChunk: (msg: Extract<BgToPanel, { type: "agent:chunk" }>) => void;
  handleAgentResponse: (msg: Extract<BgToPanel, { type: "agent:response" }>) => void;
}) {
  const { msg } = options;
  switch (msg.type) {
    case "ui:state":
      options.applyUiState(msg.state);
      return;
    case "ui:status":
      if (!options.isStreaming()) options.setStatus(msg.status);
      return;
    case "run:error":
      options.handleRunError(msg.message);
      return;
    case "slides:run":
      options.handleSlidesRun(msg);
      return;
    case "slides:local":
      options.handleSlidesLocal(msg);
      return;
    case "slides:context":
      options.handleSlidesContext(msg);
      return;
    case "ui:cache":
      options.handleUiCache(msg);
      return;
    case "ui:cache-cleared":
      options.handleCacheCleared();
      return;
    case "run:start":
      options.handleRunStart(msg.run);
      return;
    case "run:snapshot":
      options.handleRunSnapshot(msg);
      return;
    case "chat:history":
      options.handleChatHistory(msg);
      return;
    case "agent:chunk":
      options.handleAgentChunk(msg);
      return;
    case "agent:response":
      options.handleAgentResponse(msg);
      return;
  }
}

type SlidesContextMessage = Extract<BgToPanel, { type: "slides:context" }>;
type SlidesLocalMessage = Extract<BgToPanel, { type: "slides:local" }>;
type SlidesRunMessage = Extract<BgToPanel, { type: "slides:run" }>;
type UiCacheMessage = Extract<BgToPanel, { type: "ui:cache" }>;

export function createSidepanelBgMessageRuntime(options: {
  panelState: {
    ui: UiState | null;
    error: string | null;
    chatStreaming: boolean;
    currentSource: { url: string | null } | null;
    summaryMarkdown: string | null;
    slides: unknown;
  };
  dispatchPanelState?: (action: PanelStateAction) => void;
  applyUiState: (state: UiState) => void;
  setStatus: (text: string) => void;
  isStreaming: () => boolean;
  setPhase: (phase: "error", opts?: { error?: string | null }) => void;
  finishStreamingMessage: () => void;
  setSlidesBusy: (busy: boolean) => void;
  showSlideNotice: (message: string, opts?: { allowRetry?: boolean }) => void;
  getActiveTabUrl: () => string | null;
  rememberPendingSlidesRun: (value: { runId: string; url: string | null; local?: boolean }) => void;
  startSlidesStreamForRunId: (
    runId: string,
    meta?: { url?: string | null; local?: boolean },
  ) => void;
  startSlidesSummaryStreamForRunId: (runId: string, url: string | null) => void;
  handleSlidesLocal: (msg: SlidesLocalMessage) => void;
  getSlidesContextRequestId: () => number;
  setSlidesContextPending: (value: boolean) => void;
  setSlidesTranscriptTimedText: (value: string | null) => void;
  updateSlidesTextState: () => void;
  getSlidesSummaryState: () => {
    complete: boolean;
    markdown: string;
  };
  updateSlideSummaryFromMarkdown: (
    markdown: string,
    opts?: {
      preserveIfEmpty?: boolean;
      source?: "slides" | "summary";
    },
  ) => void;
  renderInlineSlidesFallback: () => void;
  schedulePanelCacheSync: () => void;
  consumeUiCache: (msg: UiCacheMessage) => {
    tabId: number;
    url: string;
    cache: unknown;
    preserveChat: boolean;
  } | null;
  clearPanelCache: () => void;
  getActiveTabId: () => number | null;
  applyPanelCache: (cache: unknown, opts: { preserveChat?: boolean }) => void;
  rememberPendingSummaryRun: (run: RunStart) => void;
  rememberPendingSummarySnapshot: (payload: { run: RunStart; markdown: string }) => void;
  attachSummaryRun: (run: RunStart) => void;
  applySummarySnapshot: (payload: { run: RunStart; markdown: string }) => void;
  handleChatHistory: (msg: Extract<BgMessage, { type: "chat:history" }>) => void;
  handleAgentChunk: (msg: Extract<BgMessage, { type: "agent:chunk" }>) => void;
  handleAgentResponse: (msg: Extract<BgMessage, { type: "agent:response" }>) => void;
}) {
  return {
    handle(msg: BgMessage) {
      handleSidepanelBgMessage({
        msg,
        applyUiState: (state) => {
          if (options.dispatchPanelState) {
            options.dispatchPanelState({ type: "ui", ui: state });
          } else {
            Object.assign(options.panelState, { ui: state });
          }
          options.applyUiState(state);
        },
        setStatus: options.setStatus,
        isStreaming: options.isStreaming,
        handleRunError: (message) => {
          const detail = message && message.trim().length > 0 ? message : "Something went wrong.";
          options.setStatus(`Error: ${detail}`);
          options.setPhase("error", { error: detail });
          if (options.panelState.chatStreaming) {
            options.finishStreamingMessage();
          }
        },
        handleSlidesRun: (slidesRun: SlidesRunMessage) => {
          if (!slidesRun.ok) {
            options.setSlidesBusy(false);
            if (slidesRun.error) {
              options.showSlideNotice(slidesRun.error, { allowRetry: true });
            }
            return;
          }
          if (!slidesRun.runId) return;
          const targetUrl = slidesRun.url ?? null;
          if (
            !shouldAcceptSlidesForCurrentPage({
              targetUrl,
              activeTabUrl: options.getActiveTabUrl(),
              currentSourceUrl: options.panelState.currentSource?.url ?? null,
            })
          ) {
            options.rememberPendingSlidesRun({
              runId: slidesRun.runId,
              url: targetUrl,
              local: Boolean(slidesRun.local),
            });
            return;
          }
          options.startSlidesStreamForRunId(slidesRun.runId, {
            url: targetUrl,
            local: Boolean(slidesRun.local),
          });
          if (!slidesRun.local) {
            options.startSlidesSummaryStreamForRunId(slidesRun.runId, targetUrl);
          }
        },
        handleSlidesLocal: options.handleSlidesLocal,
        handleSlidesContext: (slidesContext: SlidesContextMessage) => {
          if (!options.panelState.slides) return;
          const expectedId = `slides-${options.getSlidesContextRequestId()}`;
          if (slidesContext.requestId !== expectedId) return;
          options.setSlidesContextPending(false);
          options.setSlidesTranscriptTimedText(
            slidesContext.ok ? (slidesContext.transcriptTimedText ?? null) : null,
          );
          options.updateSlidesTextState();
          const slidesSummary = options.getSlidesSummaryState();
          const summarySource =
            slidesSummary.complete && slidesSummary.markdown.trim()
              ? slidesSummary.markdown
              : (options.panelState.summaryMarkdown ?? "");
          if (summarySource) {
            options.updateSlideSummaryFromMarkdown(summarySource, {
              preserveIfEmpty: false,
              source:
                slidesSummary.complete && slidesSummary.markdown.trim().length > 0
                  ? "slides"
                  : "summary",
            });
            options.renderInlineSlidesFallback();
          }
          if (!slidesContext.ok) return;
          options.schedulePanelCacheSync();
        },
        handleUiCache: (cacheMessage: UiCacheMessage) => {
          const result = options.consumeUiCache(cacheMessage);
          if (!result) return;
          if (
            options.getActiveTabId() !== result.tabId ||
            options.getActiveTabUrl() !== result.url
          ) {
            return;
          }
          if (!result.cache) return;
          options.applyPanelCache(result.cache, { preserveChat: result.preserveChat });
        },
        handleCacheCleared: options.clearPanelCache,
        handleRunStart: (run: RunStart) => {
          if (
            !shouldAcceptRunForCurrentPage({
              runUrl: run.url,
              activeTabUrl: options.getActiveTabUrl(),
              currentSourceUrl: options.panelState.currentSource?.url ?? null,
            })
          ) {
            options.rememberPendingSummaryRun(run);
            return;
          }
          options.attachSummaryRun(run);
        },
        handleRunSnapshot: (snapshot) => {
          if (
            !shouldAcceptRunForCurrentPage({
              runUrl: snapshot.run.url,
              activeTabUrl: options.getActiveTabUrl(),
              currentSourceUrl: options.panelState.currentSource?.url ?? null,
            })
          ) {
            options.rememberPendingSummarySnapshot({
              run: snapshot.run,
              markdown: snapshot.markdown,
            });
            return;
          }
          options.applySummarySnapshot({ run: snapshot.run, markdown: snapshot.markdown });
        },
        handleChatHistory: options.handleChatHistory,
        handleAgentChunk: options.handleAgentChunk,
        handleAgentResponse: options.handleAgentResponse,
      });
    },
  };
}
