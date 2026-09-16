import { buildIdleSubtitle } from "../../lib/header";
import { message as uiMessage, type LocalizedText } from "../../lib/i18n";
import type { LocalizedMetricPart } from "../../lib/metrics";
import { createStreamController } from "./stream-controller";
import { isSlidesProgressKey } from "./stream-controller-policy";
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
  friendlyFetchError: typeof import("./setup-runtime").friendlyFetchError;
  getFallbackModel: () => string | null;
  getToken: () => Promise<string>;
  handleSlides: Parameters<typeof createStreamController>[0]["onSlides"];
  handleSummaryFromCache: (value: boolean | null) => void;
  headerArmProgress: () => void;
  headerSetBaseSubtitle: (text: LocalizedText) => void;
  headerSetBaseTitle: (text: LocalizedText) => void;
  headerSetStatus: (text: LocalizedText) => void;
  headerStopProgress: () => void;
  isStreaming: () => boolean;
  maybeApplyPendingSlidesSummary: () => void;
  panelState: PanelState;

  queueSlidesRender: () => void;
  rebuildSlideDescriptions: () => void;
  refreshSummaryMetrics: (summary: string, parts?: LocalizedMetricPart[] | null) => void;
  rememberUrl: (url: string) => void;
  renderMarkdown: (markdown: string) => void;
  resetSummaryView: (opts: { clearRunId?: boolean; stopSlides?: boolean }) => void;
  schedulePanelCacheSync: () => void;
  seedPlannedSlidesForPendingRun: () => void;
  setSlidesBusy: (value: boolean) => void;
  setPhase: (phase: PanelPhase, opts?: { error?: PanelState["error"] }) => void;
  shouldRebuildSlideDescriptions: () => boolean;
  syncWithActiveTab: () => Promise<void>;
}) {
  let lastStreamError: LocalizedText | null = null;

  return {
    streamController: createStreamController({
      getToken,
      onReset: () => {
        resetSummaryView({ clearRunId: false, stopSlides: false });
        const fallbackModel = getFallbackModel();
        panelState.lastMeta = {
          inputSummaryMessage: null,
          inputSummary: null,
          model: fallbackModel,
          modelLabel: fallbackModel,
        };
        lastStreamError = null;
        seedPlannedSlidesForPendingRun();
      },
      onStatus: (text, message) => {
        headerSetStatus(message ?? text);
        if (message ? isSlidesProgressKey(message.key) : /^slides?/i.test(text.trim())) {
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
          inputSummaryMessage:
            typeof data.inputSummary === "string"
              ? (data.inputSummaryMessage ?? null)
              : data.inputSummaryMessage === null
                ? null
                : (panelState.lastMeta.inputSummaryMessage ?? null),
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
            inputSummaryMessage: panelState.lastMeta.inputSummaryMessage ?? null,
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
      onMetrics: (summary, parts) => {
        refreshSummaryMetrics(summary, parts);
      },
      onRender: renderMarkdown,
      onSyncWithActiveTab: syncWithActiveTab,
      onError: (err) => {
        const message = friendlyFetchError(err, uiMessage("stream.failed"));
        lastStreamError = message;
        return message;
      },
    }),
  };
}
