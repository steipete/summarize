import { buildIdleSubtitle } from "../../lib/header";
import { createStreamController } from "./stream-controller";
import type { PanelPhase, PanelState } from "./types";

export function createSummaryStreamRuntime({
  friendlyFetchError,
  getFallbackModel,
  getToken,
  handleSlides,
  handleSummaryFromCache,
  headerArmProgress,
  headerSetBaseSubtitle,
  headerSetBaseTitle,
  headerSetStatus,
  headerStopProgress,
  isStreaming,
  maybeApplyPendingSlidesSummary,
  panelState,

  queueSlidesRender,
  rebuildSlideDescriptions,
  refreshSummaryMetrics,
  rememberUrl,
  renderMarkdown,
  resetSummaryView,
  schedulePanelCacheSync,
  seedPlannedSlidesForPendingRun,
  setSlidesBusy,
  setPhase,
  shouldRebuildSlideDescriptions,
  syncWithActiveTab,
}: {
  friendlyFetchError: (error: unknown, fallback: string) => string;
  getFallbackModel: () => string | null;
  getToken: () => Promise<string>;
  handleSlides: Parameters<typeof createStreamController>[0]["onSlides"];
  handleSummaryFromCache: (value: boolean | null) => void;
  headerArmProgress: () => void;
  headerSetBaseSubtitle: (text: string) => void;
  headerSetBaseTitle: (text: string) => void;
  headerSetStatus: (text: string) => void;
  headerStopProgress: () => void;
  isStreaming: () => boolean;
  maybeApplyPendingSlidesSummary: () => void;
  panelState: PanelState;

  queueSlidesRender: () => void;
  rebuildSlideDescriptions: () => void;
  refreshSummaryMetrics: (summary: string) => void;
  rememberUrl: (url: string) => void;
  renderMarkdown: (markdown: string) => void;
  resetSummaryView: (opts: { clearRunId?: boolean; stopSlides?: boolean }) => void;
  schedulePanelCacheSync: () => void;
  seedPlannedSlidesForPendingRun: () => void;
  setSlidesBusy: (value: boolean) => void;
  setPhase: (phase: PanelPhase, opts?: { error?: string | null }) => void;
  shouldRebuildSlideDescriptions: () => boolean;
  syncWithActiveTab: () => Promise<void>;
}) {
  let lastStreamError: string | null = null;

  return {
    streamController: createStreamController({
      getToken,
      onReset: () => {
        resetSummaryView({ clearRunId: false, stopSlides: false });
        const fallbackModel = getFallbackModel();
        panelState.lastMeta = {
          inputSummary: null,
          model: fallbackModel,
          modelLabel: fallbackModel,
        };
        lastStreamError = null;
        seedPlannedSlidesForPendingRun();
      },
      onStatus: (text) => {
        headerSetStatus(text);
        if (/^slides?/i.test(text.trim())) {
          setSlidesBusy(true);
        }
      },
      onBaseTitle: (text) => headerSetBaseTitle(text),
      onBaseSubtitle: (text) => headerSetBaseSubtitle(text),
      onPhaseChange: (phase) => {
        if (phase === "error") {
          setPhase("error", { error: lastStreamError ?? panelState.error });
        } else {
          setPhase(phase);
        }
        if (phase === "idle") {
          maybeApplyPendingSlidesSummary();
          if (panelState.slides && shouldRebuildSlideDescriptions()) {
            rebuildSlideDescriptions();
            queueSlidesRender();
          }
        }
      },
      onRememberUrl: (url) => {
        rememberUrl(url);
      },
      onMeta: (data) => {
        panelState.lastMeta = {
          model: typeof data.model === "string" ? data.model : panelState.lastMeta.model,
          modelLabel:
            typeof data.modelLabel === "string" ? data.modelLabel : panelState.lastMeta.modelLabel,
          inputSummary:
            typeof data.inputSummary === "string"
              ? data.inputSummary
              : panelState.lastMeta.inputSummary,
        };
        headerSetBaseSubtitle(
          buildIdleSubtitle({
            inputSummary: panelState.lastMeta.inputSummary,
            modelLabel: panelState.lastMeta.modelLabel,
            model: panelState.lastMeta.model,
          }),
        );
        schedulePanelCacheSync();
      },
      onSlides: handleSlides,
      onSummaryFromCache: (value) => {
        panelState.summaryFromCache = value;
        handleSummaryFromCache(value);
        schedulePanelCacheSync();
        if (value === true) {
          headerStopProgress();
        } else if (value === false && isStreaming()) {
          headerArmProgress();
        }
      },
      onMetrics: (summary) => {
        refreshSummaryMetrics(summary);
      },
      onRender: renderMarkdown,
      onSyncWithActiveTab: syncWithActiveTab,
      onError: (err) => {
        const message = friendlyFetchError(err, "Stream failed");
        lastStreamError = message;
        return message;
      },
    }),
  };
}
