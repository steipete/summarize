import { daemonFetch } from "../../lib/daemon-fetch";
import { getDaemonOrigin } from "../../lib/daemon-url";
import type { Settings, SlidesLayout } from "../../lib/settings";
import { applyPanelStateAction, type PanelStateAction } from "./panel-state-store";
import type { SlideTextMode } from "./slides-state";
import { resolveSlidesRenderLayout } from "./slides-view-policy";
import type { PanelState } from "./types";

type SlidesTextControllerLike = {
  setTextMode: (value: SlideTextMode) => boolean;
};

type SummarizeControlRuntimeOptions = {
  renderMarkdownHostEl: HTMLElement;
  renderSlidesHostEl: HTMLElement;
  slidesLayoutEl: HTMLSelectElement;
  slidesTextController: SlidesTextControllerLike;
  panelState: PanelState;
  dispatchPanelState?: (action: PanelStateAction) => void;
  patchSettings: (patch: Partial<Settings>) => Promise<void>;
  loadSettings: () => Promise<Pick<Settings, "slideRuntime" | "token">>;
  showSlideNotice: (message: string) => void;
  hideSlideNotice: () => void;
  setSlidesBusy: (value: boolean) => void;
  stopSlidesStream: () => void;
  maybeApplyPendingSlidesSummary: () => void;
  maybeStartPendingSlidesForUrl: (url: string | null) => void;
  sendSummarize: (opts?: { refresh?: boolean }) => void;
  resolveActiveSlidesRunId: () => string | null;
  isActiveSlidesRunLocal?: (runId: string) => boolean;
  startSlidesStreamForRunId: (runId: string) => void;
  startSlidesSummaryStreamForRunId: (runId: string, url: string | null) => void;
  renderMarkdownDisplay: () => void;
  renderInlineSlidesFallback: () => void;
  queueSlidesRender: () => void;
  applySlidesRendererLayout: () => void;
  daemonFetchImpl?: typeof fetch;
};

type SummarizeControlPayload = { mode: "page" | "video"; slides: boolean };

async function fetchSlideTools(
  tokenValue: string,
  requireOcr: boolean,
  fetchImpl: typeof fetch = daemonFetch,
): Promise<{ ok: boolean; missing: string[] }> {
  const token = tokenValue.trim();
  if (!token) return { ok: false, missing: ["daemon token"] };
  const origin = await getDaemonOrigin();
  const res = await fetchImpl(`${origin}/v1/tools`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) return { ok: false, missing: ["daemon tools endpoint"] };
  const json = (await res.json()) as {
    ok?: boolean;
    tools?: {
      ytDlp?: { available?: boolean };
      ffmpeg?: { available?: boolean };
      tesseract?: { available?: boolean };
    };
  };
  if (!json.ok || !json.tools) return { ok: false, missing: ["daemon tools endpoint"] };
  const missing: string[] = [];
  if (!json.tools.ytDlp?.available) missing.push("yt-dlp");
  if (!json.tools.ffmpeg?.available) missing.push("ffmpeg");
  if (requireOcr && !json.tools.tesseract?.available) missing.push("tesseract");
  return { ok: missing.length === 0, missing };
}

export function createSummarizeControlRuntime(options: SummarizeControlRuntimeOptions) {
  const dispatch = (action: PanelStateAction) => {
    if (options.dispatchPanelState) {
      options.dispatchPanelState(action);
    } else {
      applyPanelStateAction(options.panelState, action);
    }
  };
  const getEffectiveMode = () =>
    options.panelState.slidesSession.inputModeOverride ??
    options.panelState.slidesSession.inputMode;

  const handleSlidesTextModeChange = (next: SlideTextMode) => {
    if (next === "ocr" && !options.panelState.slidesSession.slidesOcrEnabled) return;
    if (!options.slidesTextController.setTextMode(next)) return;
    if (options.panelState.summaryMarkdown) {
      options.renderInlineSlidesFallback();
    } else {
      options.queueSlidesRender();
    }
  };

  const handleSummarizeControlChange = async (value: SummarizeControlPayload) => {
    const prevSlides = options.panelState.slidesSession.slidesEnabled;
    const prevMode = options.panelState.slidesSession.inputMode;
    if (value.slides && !prevSlides) {
      const settings = await options.loadSettings();
      if (settings.slideRuntime === "daemon") {
        const tools = await fetchSlideTools(
          settings.token,
          options.panelState.slidesSession.slidesOcrEnabled,
          options.daemonFetchImpl,
        );
        if (!tools.ok) {
          options.showSlideNotice(
            `Slide extraction requires ${tools.missing.join(", ")}. Install and restart the daemon.`,
          );
          return;
        }
      }
      options.hideSlideNotice();
    } else if (!value.slides) {
      options.hideSlideNotice();
      options.setSlidesBusy(false);
      options.stopSlidesStream();
    }

    dispatch({
      type: "slides-session-update",
      value: {
        inputMode: value.mode,
        inputModeOverride: value.mode,
        slidesEnabled: value.slides,
      },
    });
    await options.patchSettings({ slidesEnabled: value.slides });

    if (value.slides && getEffectiveMode() === "video") {
      options.maybeApplyPendingSlidesSummary();
      options.maybeStartPendingSlidesForUrl(options.panelState.navigation.activeTabUrl);
    }
    if (
      options.panelState.panelSession.autoSummarize &&
      (value.mode !== prevMode || value.slides !== prevSlides)
    ) {
      options.sendSummarize({ refresh: true });
    }
  };

  const retrySlidesStream = () => {
    if (!options.panelState.slidesSession.slidesEnabled) return;
    options.hideSlideNotice();
    const runId = options.resolveActiveSlidesRunId();
    const targetUrl =
      options.panelState.currentSource?.url ?? options.panelState.navigation.activeTabUrl ?? null;
    if (runId) {
      const isLocalRun = options.isActiveSlidesRunLocal?.(runId) === true;
      options.startSlidesStreamForRunId(runId);
      if (!isLocalRun) {
        options.startSlidesSummaryStreamForRunId(runId, targetUrl);
      }
      return;
    }
    options.sendSummarize({ refresh: true });
  };

  const applySlidesLayout = () => {
    options.renderMarkdownHostEl.classList.remove("hidden");
    options.renderSlidesHostEl.dataset.layout = resolveSlidesRenderLayout({
      preferredLayout: options.panelState.slidesSession.slidesLayout,
      slidesEnabled: options.panelState.slidesSession.slidesEnabled,
      inputMode: getEffectiveMode(),
    });
    options.renderMarkdownDisplay();
    options.applySlidesRendererLayout();
  };

  const setSlidesLayout = (next: SlidesLayout) => {
    if (next === options.panelState.slidesSession.slidesLayout) return;
    dispatch({
      type: "slides-session-update",
      value: { slidesLayout: next },
    });
    options.slidesLayoutEl.value = next;
    applySlidesLayout();
  };

  return {
    applySlidesLayout,
    handleSummarizeControlChange,
    handleSlidesTextModeChange,
    retrySlidesStream,
    setSlidesLayout,
  };
}
