import type { RunStart, UiState, PanelState, PanelPhase } from "./types";

export function createSlidesRunRuntime(options: {
  getPanelPhase: () => PanelPhase;
  getPanelState: () => PanelState;
  getUiState: () => UiState | null;
  getActiveTabUrl: () => string | null;
  getInputMode: () => "page" | "video";
  setInputMode: (value: "page" | "video") => void;
  getInputModeOverride: () => "page" | "video" | null;
  setInputModeOverride: (value: "page" | "video" | null) => void;
  getSlidesEnabled: () => boolean;
  refreshSummarizeControl: () => void;
  stopSlidesStream: () => void;
  stopSlidesSummaryStream: () => void;
  hideSlideNotice: () => void;
  setSlidesBusy: (value: boolean) => void;
  schedulePanelCacheSync: () => void;
  startSlidesHydrator: (runId: string, opts?: { local?: boolean }) => void;
  startSlidesSummaryController: (payload: {
    id: string;
    url: string;
    title: string | null;
    model: string;
    reason: "slides-summary";
  }) => void;
  getSlidesSummaryRunId: () => string | null;
  setSlidesSummaryRunId: (value: string | null) => void;
  setSlidesSummaryUrl: (value: string | null) => void;
  resetSlidesSummaryState: () => void;
  setSlidesSummaryModel: (value: string | null) => void;
  setSlidesRunId: (value: string | null) => void;
  headerSetStatus: (text: string) => void;
}) {
  const ensureVideoMode = () => {
    const effectiveInputMode = options.getInputModeOverride() ?? options.getInputMode();
    if (effectiveInputMode === "video") return;
    options.setInputMode("video");
    options.setInputModeOverride("video");
    options.refreshSummarizeControl();
  };

  const handleSlidesStatus = (text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    if (!/^slides?/i.test(trimmed)) return;
    options.setSlidesBusy(true);
    if (options.getPanelPhase() === "connecting" || options.getPanelPhase() === "streaming") return;
    options.headerSetStatus(trimmed);
  };

  const startSlidesStreamForRunId = (runId: string, opts?: { local?: boolean }) => {
    const ui = options.getUiState();
    const slidesAllowed = options.getSlidesEnabled() || ui?.settings.slidesEnabled;
    if (!slidesAllowed) {
      options.stopSlidesStream();
      return;
    }
    ensureVideoMode();
    options.hideSlideNotice();
    options.setSlidesBusy(true);
    options.setSlidesRunId(runId);
    options.schedulePanelCacheSync();
    options.startSlidesHydrator(runId, opts);
  };

  const startSlidesStream = (run: RunStart) => {
    startSlidesStreamForRunId(run.id);
  };

  const startSlidesSummaryStreamForRunId = (runId: string, targetUrl?: string | null) => {
    const ui = options.getUiState();
    const slidesAllowed = options.getSlidesEnabled() || ui?.settings.slidesEnabled;
    if (!slidesAllowed) {
      options.stopSlidesSummaryStream();
      return;
    }
    ensureVideoMode();
    if (options.getSlidesSummaryRunId() === runId) return;
    options.stopSlidesSummaryStream();
    options.setSlidesSummaryRunId(runId);
    options.setSlidesSummaryUrl(targetUrl ?? null);
    options.resetSlidesSummaryState();
    const panelState = options.getPanelState();
    options.setSlidesSummaryModel(panelState.lastMeta.model ?? ui?.settings.model ?? "auto");
    options.startSlidesSummaryController({
      id: runId,
      url: targetUrl ?? panelState.currentSource?.url ?? options.getActiveTabUrl() ?? "",
      title: panelState.currentSource?.title ?? null,
      model: panelState.lastMeta.model ?? "auto",
      reason: "slides-summary",
    });
  };

  return {
    handleSlidesStatus,
    startSlidesStreamForRunId,
    startSlidesStream,
    startSlidesSummaryStreamForRunId,
  };
}
