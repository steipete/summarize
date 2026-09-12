import { patchPanelState, setPendingSlidesRun } from "./panel-state-store";
import { normalizePanelUrl } from "./session-policy";
import { hasResolvedSlidesPayload } from "./slides-pending";
import { resolveSlidesInputMode } from "./slides-session-state";
import type { PanelState, RunStart } from "./types";

export function createSlidesRunRuntime(options: {
  panelState: PanelState;

  refreshSummarizeControl: () => void;
  hideSlideNotice: () => void;
  setSlidesBusy: (value: boolean) => void;
  schedulePanelCacheSync: () => void;
  isSlidesHydratorStreaming: () => boolean;
  startSlidesHydrator: (runId: string, opts?: { local?: boolean }) => void;
  stopSlidesHydrator: () => void;
  startSlidesSummaryController: (payload: {
    id: string;
    url: string;
    title: string | null;
    model: string;
    reason: "slides-summary";
  }) => void;
  stopSlidesSummaryController: () => void;
  getSlidesSummaryRunId: () => string | null;
  setSlidesSummaryRunId: (value: string | null) => void;
  setSlidesSummaryUrl: (value: string | null) => void;
  resetSlidesSummaryState: () => void;
  setSlidesSummaryModel: (value: string | null) => void;
  shouldUseBrowserAiSlides: () => boolean;
  headerSetStatus: (text: string) => void;
}) {
  const ensureVideoMode = () => {
    if (resolveSlidesInputMode(options.panelState.slidesSession) === "video") return;
    patchPanelState(options.panelState, "slidesSession", {
      inputMode: "video",
      inputModeOverride: "video",
    });
    options.refreshSummarizeControl();
  };

  const slidesAllowed = () =>
    options.panelState.slidesSession.slidesEnabled ||
    Boolean(options.panelState.ui?.settings.slidesEnabled);

  const handleSlidesStatus = (text: string) => {
    const trimmed = text.trim();
    if (!trimmed || !/^slides?/i.test(trimmed)) return;
    options.setSlidesBusy(true);
    if (options.panelState.phase === "connecting" || options.panelState.phase === "streaming")
      return;
    options.headerSetStatus(trimmed);
  };

  const stopSlidesSummaryStream = () => {
    options.stopSlidesSummaryController();
  };

  const stopSlidesStream = () => {
    patchPanelState(options.panelState, "slidesLifecycle", { activeRun: null });
    options.stopSlidesHydrator();
    options.setSlidesBusy(false);
    options.panelState.slidesRunId = null;
    stopSlidesSummaryStream();
  };

  const startSlidesStreamCore = (runId: string, opts?: { local?: boolean }) => {
    if (!slidesAllowed()) {
      stopSlidesStream();
      return;
    }
    ensureVideoMode();
    options.hideSlideNotice();
    options.setSlidesBusy(true);
    options.panelState.slidesRunId = runId;
    options.schedulePanelCacheSync();
    options.startSlidesHydrator(runId, opts);
  };

  const startSlidesStreamForRunId = (
    runId: string,
    meta?: { url?: string | null; local?: boolean },
  ) => {
    const currentActiveRun = options.panelState.slidesLifecycle.activeRun;
    const existing = currentActiveRun?.runId === runId ? currentActiveRun : null;
    const activeRun = {
      runId,
      url:
        meta?.url ??
        existing?.url ??
        options.panelState.currentSource?.url ??
        options.panelState.navigation.activeTabUrl ??
        null,
      local: meta?.local ?? existing?.local ?? false,
    };
    patchPanelState(options.panelState, "slidesLifecycle", { activeRun: activeRun });
    startSlidesStreamCore(runId, { local: activeRun.local });
  };

  const startSlidesStream = (run: RunStart) => {
    startSlidesStreamForRunId(run.id, { url: run.url });
  };

  const startSlidesSummaryStreamForRunId = (runId: string, targetUrl?: string | null) => {
    const activeRun = options.panelState.slidesLifecycle.activeRun;
    if (activeRun?.runId === runId && activeRun.local) return;
    if (options.shouldUseBrowserAiSlides()) {
      stopSlidesSummaryStream();
      return;
    }
    if (!slidesAllowed()) {
      stopSlidesSummaryStream();
      return;
    }
    ensureVideoMode();
    if (options.getSlidesSummaryRunId() === runId) return;
    stopSlidesSummaryStream();
    options.setSlidesSummaryRunId(runId);
    options.setSlidesSummaryUrl(targetUrl ?? null);
    options.resetSlidesSummaryState();
    const model =
      options.panelState.lastMeta.model ?? options.panelState.ui?.settings.model ?? "auto";
    options.setSlidesSummaryModel(model);
    options.startSlidesSummaryController({
      id: runId,
      url:
        targetUrl ??
        options.panelState.currentSource?.url ??
        options.panelState.navigation.activeTabUrl ??
        "",
      title: options.panelState.currentSource?.title ?? null,
      model: options.panelState.lastMeta.model ?? "auto",
      reason: "slides-summary",
    });
  };

  const resolveActiveSlidesRunId = () => {
    if (options.panelState.slidesRunId) return options.panelState.slidesRunId;
    if (options.panelState.slides && options.panelState.runId) return options.panelState.runId;
    return null;
  };

  const isActiveSlidesRunLocal = (runId: string) =>
    options.panelState.slidesLifecycle.activeRun?.runId === runId &&
    options.panelState.slidesLifecycle.activeRun.local;

  const rememberPendingSlidesRun = (value: {
    runId: string;
    url: string | null;
    local?: boolean;
  }) => {
    if (!value.url) return;
    setPendingSlidesRun(options.panelState, normalizePanelUrl(value.url), value);
  };

  const maybeStartPendingSlidesForUrl = (url: string | null) => {
    if (!url) return;
    const key = normalizePanelUrl(url);
    const pending = options.panelState.pendingRuns.slidesByUrl[key];
    if (!pending) return;
    if (!options.panelState.slidesSession.slidesEnabled) return;
    if (resolveSlidesInputMode(options.panelState.slidesSession) !== "video") return;
    if (options.isSlidesHydratorStreaming()) return;
    setPendingSlidesRun(options.panelState, key, null);
    if (
      hasResolvedSlidesPayload(
        options.panelState.slides,
        options.panelState.slidesSession.slidesSeededSourceId,
      )
    ) {
      return;
    }
    startSlidesStreamForRunId(pending.runId, {
      url: pending.url,
      local: Boolean(pending.local),
    });
    if (!pending.local) startSlidesSummaryStreamForRunId(pending.runId, pending.url);
  };

  return {
    handleSlidesStatus,
    isActiveSlidesRunLocal,
    maybeStartPendingSlidesForUrl,
    rememberPendingSlidesRun,
    resolveActiveSlidesRunId,
    startSlidesStream,
    startSlidesStreamForRunId,
    startSlidesSummaryStreamForRunId,
    stopSlidesStream,
  };
}
