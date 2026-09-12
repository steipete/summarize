import { extractYouTubeVideoId } from "@steipete/summarize-core/content/url";
import { patchPanelState } from "./panel-state-store";
import { panelUrlsMatch } from "./session-policy";
import { shouldSeedPlannedSlidesForRun } from "./slides-seed-policy";
import { resolveSlidesInputMode } from "./slides-session-state";
import type { PanelState, RunStart } from "./types";

export function createPlannedSlidesRuntime({
  panelState,

  getActiveTabUrl,
  getLengthValue,
  updateSlidesTextState,
  queueSlidesRender,
  schedulePanelCacheSync,
}: {
  panelState: PanelState;

  getActiveTabUrl: () => string | null;
  getLengthValue: () => string;
  updateSlidesTextState: () => void;
  queueSlidesRender: () => void;
  schedulePanelCacheSync: (delayMs?: number) => void;
}) {
  const getSourceId = (run: RunStart) => {
    const youtubeId = extractYouTubeVideoId(run.url);
    return youtubeId ? `youtube-${youtubeId}` : `planned-${run.id}`;
  };

  const currentRunHasResolvedSlideImages = (run: RunStart) => {
    if (!panelState.slides) return false;
    const hasResolvedImages = panelState.slides.slides.some(
      (slide) => (slide.imageUrl ?? "").trim().length > 0,
    );
    if (!hasResolvedImages) return false;
    if (panelState.runId === run.id || panelState.slidesRunId === run.id) return true;
    const sourceUrl =
      panelState.slides.sourceUrl || panelState.currentSource?.url || getActiveTabUrl();
    return sourceUrl ? panelUrlsMatch(run.url, sourceUrl) : false;
  };

  const seedForRun = (run: RunStart) => {
    const durationSeconds =
      panelState.slidesSession.summarizeVideoDurationSeconds ??
      panelState.ui?.stats.videoDurationSeconds ??
      null;
    const hasDuration =
      typeof durationSeconds === "number" &&
      Number.isFinite(durationSeconds) &&
      durationSeconds > 0;
    if (
      !shouldSeedPlannedSlidesForRun({
        durationSeconds,
        inputMode: resolveSlidesInputMode(panelState.slidesSession),
        media: panelState.ui?.media,
        mediaAvailable: panelState.slidesSession.mediaAvailable,
        runUrl: run.url,
        slidesEnabled: panelState.slidesSession.slidesEnabled,
      })
    ) {
      return false;
    }

    const normalized = getLengthValue().trim().toLowerCase();
    const chunkSeconds =
      normalized === "short"
        ? 600
        : normalized === "medium"
          ? 450
          : normalized === "long"
            ? 300
            : normalized === "xl"
              ? 180
              : normalized === "xxl"
                ? 120
                : 300;
    const target = hasDuration ? Math.max(3, Math.round(durationSeconds / chunkSeconds)) : 6;
    const count = Math.max(3, Math.min(80, target));
    const youtubeId = extractYouTubeVideoId(run.url);
    const sourceId = getSourceId(run);
    const sourceKind = youtubeId ? "youtube" : "direct";
    if (currentRunHasResolvedSlideImages(run)) return true;

    const existingSlides = panelState.slides?.sourceId === sourceId ? panelState.slides : null;
    if (existingSlides && existingSlides.slides.length > 0) {
      const hasResolvedImages = existingSlides.slides.some(
        (slide) => (slide.imageUrl ?? "").trim().length > 0,
      );
      const hasUsableTimestamps = existingSlides.slides.some((slide) =>
        Number.isFinite(slide.timestamp),
      );
      if (hasResolvedImages || !hasDuration || hasUsableTimestamps) return true;
    }

    const slides = Array.from({ length: count }, (_, index) => {
      const ratio = count <= 1 ? 0 : index / Math.max(1, count - 1);
      const timestamp = hasDuration
        ? Math.max(0, Math.min(durationSeconds - 0.1, ratio * durationSeconds))
        : Number.NaN;
      return { index: index + 1, timestamp, imageUrl: "" };
    });

    panelState.slides = {
      sourceUrl: run.url,
      sourceId,
      sourceKind,
      ocrAvailable: false,
      slides,
    };
    patchPanelState(panelState, "slidesSession", { slidesSeededSourceId: sourceId });
    updateSlidesTextState();
    queueSlidesRender();
    schedulePanelCacheSync(0);
    return true;
  };

  const getPendingRun = () => {
    const plannedRun = panelState.slidesLifecycle.plannedRun;
    if (!plannedRun) return null;
    return panelState.runId === plannedRun.id || panelState.slidesRunId === plannedRun.id
      ? plannedRun
      : null;
  };

  const isCurrentRun = (run: RunStart) => {
    const currentUrl =
      panelState.currentSource?.url ?? getActiveTabUrl() ?? panelState.ui?.tab.url ?? null;
    return currentUrl ? panelUrlsMatch(run.url, currentUrl) : false;
  };

  const hasUsableTimingOrImages = (run: RunStart) => {
    if (currentRunHasResolvedSlideImages(run)) return true;
    const sourceId = getSourceId(run);
    if (!panelState.slides || panelState.slides.sourceId !== sourceId) return false;
    return panelState.slides.slides.some(
      (slide) => Number.isFinite(slide.timestamp) || (slide.imageUrl ?? "").trim().length > 0,
    );
  };

  const clearPendingRun = () => {
    patchPanelState(panelState, "slidesLifecycle", { plannedRun: null });
  };

  const maybeSeedPendingRun = () => {
    const pendingRun = getPendingRun();
    if (!pendingRun || !isCurrentRun(pendingRun)) return false;
    if (!seedForRun(pendingRun)) return false;
    if (hasUsableTimingOrImages(pendingRun)) clearPendingRun();
    return true;
  };

  const seedPendingRunAndConsumeWhenReady = () => {
    const pendingRun = getPendingRun();
    if (!pendingRun || !isCurrentRun(pendingRun)) return;
    if (seedForRun(pendingRun) && hasUsableTimingOrImages(pendingRun)) {
      clearPendingRun();
    }
  };

  return {
    maybeSeedPendingRun,
    seedForRun,
    seedPendingRunAndConsumeWhenReady,
  };
}
