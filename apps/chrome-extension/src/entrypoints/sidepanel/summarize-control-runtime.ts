import type { Settings, SlidesLayout } from "../../lib/settings";
import { mountSummarizeControl } from "./pickers";
import type { SlideTextMode } from "./slides-state";
import { resolveSlidesRenderLayout } from "./slides-view-policy";

type SummarizeControlState = {
  inputMode: "page" | "video";
  inputModeOverride: "page" | "video" | null;
  hasSummaryMarkdown: boolean;
  slidesEnabled: boolean;
  slidesOcrEnabled: boolean;
  autoSummarize: boolean;
  slidesBusy: boolean;
  mediaAvailable: boolean;
  slidesLayout: SlidesLayout;
  summarizeVideoLabel: string;
  summarizePageWords: number | null;
  summarizeVideoDurationSeconds: number | null;
  activeTabUrl: string | null;
  currentSourceUrl: string | null;
};

type SlidesTextControllerLike = {
  getTextMode: () => SlideTextMode;
  getTextToggleVisible: () => boolean;
  setTextMode: (value: SlideTextMode) => boolean;
};

type SummarizeControlRuntimeOptions = {
  summarizeControlRoot: HTMLElement;
  renderMarkdownHostEl: HTMLElement;
  renderSlidesHostEl: HTMLElement;
  slidesLayoutEl: HTMLSelectElement;
  slidesTextController: SlidesTextControllerLike;
  getState: () => SummarizeControlState;
  setInputMode: (value: "page" | "video") => void;
  setInputModeOverride: (value: "page" | "video" | null) => void;
  setSlidesEnabled: (value: boolean) => void;
  setSlidesLayoutValue: (value: SlidesLayout) => void;
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
};

type SummarizeControlPayload = { mode: "page" | "video"; slides: boolean };

async function fetchSlideTools(
  tokenValue: string,
  requireOcr: boolean,
): Promise<{ ok: boolean; missing: string[] }> {
  const token = tokenValue.trim();
  if (!token) return { ok: false, missing: ["daemon token"] };
  const res = await fetch("http://127.0.0.1:8787/v1/tools", {
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
  const getEffectiveMode = () =>
    options.getState().inputModeOverride ?? options.getState().inputMode;

  const handleSlidesTextModeChange = (next: SlideTextMode) => {
    const state = options.getState();
    if (next === "ocr" && !state.slidesOcrEnabled) return;
    if (!options.slidesTextController.setTextMode(next)) return;
    if (state.hasSummaryMarkdown) {
      options.renderInlineSlidesFallback();
    } else {
      options.queueSlidesRender();
    }
    refreshSummarizeControl();
  };

  const handleSummarizeControlChange = async (value: SummarizeControlPayload) => {
    const state = options.getState();
    const prevSlides = state.slidesEnabled;
    const prevMode = state.inputMode;
    if (value.slides && !state.slidesEnabled) {
      const settings = await options.loadSettings();
      if (settings.slideRuntime === "daemon") {
        const tools = await fetchSlideTools(settings.token, state.slidesOcrEnabled);
        if (!tools.ok) {
          options.showSlideNotice(
            `Slide extraction requires ${tools.missing.join(", ")}. Install and restart the daemon.`,
          );
          refreshSummarizeControl();
          return;
        }
      }
      options.hideSlideNotice();
    } else if (!value.slides) {
      options.hideSlideNotice();
      options.setSlidesBusy(false);
      options.stopSlidesStream();
    }

    options.setInputMode(value.mode);
    options.setInputModeOverride(value.mode);
    options.setSlidesEnabled(value.slides);
    await options.patchSettings({ slidesEnabled: value.slides });

    if (value.slides && getEffectiveMode() === "video") {
      options.maybeApplyPendingSlidesSummary();
      options.maybeStartPendingSlidesForUrl(options.getState().activeTabUrl);
    }
    if (state.autoSummarize && (value.mode !== prevMode || value.slides !== prevSlides)) {
      options.sendSummarize({ refresh: true });
    }
    refreshSummarizeControl();
  };

  const retrySlidesStream = () => {
    const state = options.getState();
    if (!state.slidesEnabled) return;
    options.hideSlideNotice();
    const runId = options.resolveActiveSlidesRunId();
    const targetUrl = state.currentSourceUrl ?? state.activeTabUrl ?? null;
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
    const state = options.getState();
    options.renderMarkdownHostEl.classList.remove("hidden");
    options.renderSlidesHostEl.dataset.layout = resolveSlidesRenderLayout({
      preferredLayout: state.slidesLayout,
      slidesEnabled: state.slidesEnabled,
      inputMode: getEffectiveMode(),
    });
    options.renderMarkdownDisplay();
    options.applySlidesRendererLayout();
  };

  const setSlidesLayout = (next: SlidesLayout) => {
    if (next === options.getState().slidesLayout) return;
    options.setSlidesLayoutValue(next);
    options.slidesLayoutEl.value = next;
    applySlidesLayout();
  };

  const summarizeControl = mountSummarizeControl(options.summarizeControlRoot, {
    mode: options.getState().inputMode,
    slidesEnabled: options.getState().slidesEnabled,
    mediaAvailable: false,
    videoLabel: "Video",
    busy: false,
    slidesTextMode: options.slidesTextController.getTextMode(),
    slidesTextToggleVisible: options.slidesTextController.getTextToggleVisible(),
    onSlidesTextModeChange: handleSlidesTextModeChange,
    onChange: handleSummarizeControlChange,
    onSummarize: () => options.sendSummarize(),
  });

  function refreshSummarizeControl() {
    const state = options.getState();
    summarizeControl.update({
      mode: state.inputMode,
      slidesEnabled: state.slidesEnabled,
      mediaAvailable: state.mediaAvailable,
      busy: state.slidesBusy,
      videoLabel: state.summarizeVideoLabel,
      pageWords: state.summarizePageWords,
      videoDurationSeconds: state.summarizeVideoDurationSeconds,
      slidesTextMode: options.slidesTextController.getTextMode(),
      slidesTextToggleVisible: options.slidesTextController.getTextToggleVisible(),
      onSlidesTextModeChange: handleSlidesTextModeChange,
      onChange: handleSummarizeControlChange,
      onSummarize: () => options.sendSummarize(),
    });
  }

  return {
    applySlidesLayout,
    handleSummarizeControlChange,
    refreshSummarizeControl,
    retrySlidesStream,
    setSlidesLayout,
  };
}
