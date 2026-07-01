import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createInitialPanelState,
  createPanelStateStore,
} from "../apps/chrome-extension/src/entrypoints/sidepanel/panel-state-store";
import type { SlideTextMode } from "../apps/chrome-extension/src/entrypoints/sidepanel/slides-state";
import { createSummarizeControlRuntime } from "../apps/chrome-extension/src/entrypoints/sidepanel/summarize-control-runtime";
import { createSummarizeControlView } from "../apps/chrome-extension/src/entrypoints/sidepanel/summarize-control-view";
import type { Settings, SlidesLayout } from "../apps/chrome-extension/src/lib/settings";

type SummarizeControlProps = {
  mode: "page" | "video";
  slidesEnabled: boolean;
  mediaAvailable: boolean;
  busy?: boolean;
  videoLabel?: string;
  pageWords?: number | null;
  videoDurationSeconds?: number | null;
  slidesTextMode?: SlideTextMode;
  slidesTextToggleVisible?: boolean;
  onSlidesTextModeChange?: (value: SlideTextMode) => void;
  onChange: (value: { mode: "page" | "video"; slides: boolean }) => void | Promise<void>;
  onSummarize: () => void;
};

let currentProps: SummarizeControlProps | null = null;
const summarizeControlUpdate = vi.fn();

vi.mock("../apps/chrome-extension/src/entrypoints/sidepanel/pickers", () => ({
  mountSummarizeControl: (_root: HTMLElement, props: SummarizeControlProps) => {
    currentProps = props;
    return {
      update: (next: SummarizeControlProps) => {
        currentProps = next;
        summarizeControlUpdate(next);
      },
    };
  },
}));

function buildState(overrides: Partial<ReturnType<typeof baseState>> = {}) {
  return { ...baseState(), ...overrides };
}

function baseState() {
  return {
    inputMode: "page" as const,
    inputModeOverride: null as "page" | "video" | null,
    hasSummaryMarkdown: false,
    slidesEnabled: false,
    slidesOcrEnabled: true,
    autoSummarize: false,
    slidesBusy: false,
    mediaAvailable: true,
    slidesLayout: "gallery" as SlidesLayout,
    summarizeVideoLabel: "Video",
    summarizePageWords: 320,
    summarizeVideoDurationSeconds: 120,
    activeTabUrl: "https://example.com/video",
    currentSourceUrl: "https://example.com/video",
  };
}

function buildRuntime(
  overrides: {
    state?: Partial<ReturnType<typeof baseState>>;
    resolveActiveSlidesRunId?: () => string | null;
    isActiveSlidesRunLocal?: (runId: string) => boolean;
    slidesTextSetResult?: boolean;
    settings?: Pick<Settings, "slideRuntime" | "token">;
  } = {},
) {
  currentProps = null;
  summarizeControlUpdate.mockReset();

  const state = buildState(overrides.state);
  const initialPanelState = createInitialPanelState();
  Object.assign(initialPanelState.slidesSession, {
    inputMode: state.inputMode,
    inputModeOverride: state.inputModeOverride,
    slidesEnabled: state.slidesEnabled,
    slidesOcrEnabled: state.slidesOcrEnabled,
    slidesBusy: state.slidesBusy,
    mediaAvailable: state.mediaAvailable,
    slidesLayout: state.slidesLayout,
    summarizeVideoLabel: state.summarizeVideoLabel,
    summarizePageWords: state.summarizePageWords,
    summarizeVideoDurationSeconds: state.summarizeVideoDurationSeconds,
  });
  initialPanelState.summaryMarkdown = state.hasSummaryMarkdown ? "# Summary" : null;
  initialPanelState.panelSession.autoSummarize = state.autoSummarize;
  initialPanelState.navigation.activeTabUrl = state.activeTabUrl;
  initialPanelState.currentSource = state.currentSourceUrl
    ? { url: state.currentSourceUrl, title: null }
    : null;
  const panelStateStore = createPanelStateStore(initialPanelState);
  const calls = {
    patchSettings: vi.fn(async (_patch: Partial<Settings>) => {}),
    loadSettings: vi.fn(
      async () => overrides.settings ?? { slideRuntime: "browser" as const, token: "token" },
    ),
    showSlideNotice: vi.fn(),
    hideSlideNotice: vi.fn(),
    setSlidesBusy: vi.fn((value: boolean) => {
      panelStateStore.dispatch({
        type: "slides-session-update",
        value: { slidesBusy: value },
      });
    }),
    stopSlidesStream: vi.fn(),
    maybeApplyPendingSlidesSummary: vi.fn(),
    maybeStartPendingSlidesForUrl: vi.fn(),
    sendSummarize: vi.fn(),
    startSlidesStreamForRunId: vi.fn(),
    startSlidesSummaryStreamForRunId: vi.fn(),
    renderMarkdownDisplay: vi.fn(),
    renderInlineSlidesFallback: vi.fn(),
    queueSlidesRender: vi.fn(),
    applySlidesRendererLayout: vi.fn(),
  };

  const renderMarkdownHostEl = {
    classList: { remove: vi.fn() },
  } as unknown as HTMLElement;
  const renderSlidesHostEl = { dataset: {} as Record<string, string> } as HTMLElement;
  const slidesLayoutEl = { value: state.slidesLayout } as HTMLSelectElement;

  const slidesTextController = {
    getTextMode: vi.fn(() => "transcript" as SlideTextMode),
    getTextToggleVisible: vi.fn(() => true),
    setTextMode: vi.fn(() => overrides.slidesTextSetResult ?? true),
  };

  const view = createSummarizeControlView({
    root: {} as HTMLElement,
    panelState: panelStateStore.state,
    slidesTextController,
  });
  const runtime = createSummarizeControlRuntime({
    renderMarkdownHostEl,
    renderSlidesHostEl,
    slidesLayoutEl,
    slidesTextController,
    panelState: panelStateStore.state,
    dispatchPanelState: panelStateStore.dispatch,
    patchSettings: calls.patchSettings,
    loadSettings: calls.loadSettings,
    showSlideNotice: calls.showSlideNotice,
    hideSlideNotice: calls.hideSlideNotice,
    setSlidesBusy: calls.setSlidesBusy,
    stopSlidesStream: calls.stopSlidesStream,
    maybeApplyPendingSlidesSummary: calls.maybeApplyPendingSlidesSummary,
    maybeStartPendingSlidesForUrl: calls.maybeStartPendingSlidesForUrl,
    sendSummarize: calls.sendSummarize,
    resolveActiveSlidesRunId: overrides.resolveActiveSlidesRunId ?? (() => null),
    isActiveSlidesRunLocal: overrides.isActiveSlidesRunLocal,
    startSlidesStreamForRunId: calls.startSlidesStreamForRunId,
    startSlidesSummaryStreamForRunId: calls.startSlidesSummaryStreamForRunId,
    renderMarkdownDisplay: calls.renderMarkdownDisplay,
    renderInlineSlidesFallback: calls.renderInlineSlidesFallback,
    queueSlidesRender: calls.queueSlidesRender,
    applySlidesRendererLayout: calls.applySlidesRendererLayout,
    daemonFetchImpl: fetch,
  });
  view.bindActions({
    onSlidesTextModeChange: runtime.handleSlidesTextModeChange,
    onChange: runtime.handleSummarizeControlChange,
    onSummarize: () => calls.sendSummarize(),
  });

  return {
    state: panelStateStore.state,
    calls,
    runtime,
    view,
    currentProps: () => currentProps,
    renderMarkdownHostEl,
    renderSlidesHostEl,
    slidesLayoutEl,
    slidesTextController,
  };
}

describe("sidepanel summarize control runtime", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    summarizeControlUpdate.mockReset();
    currentProps = null;
  });

  it("mounts only after actions bind and ignores later bindings", () => {
    const firstSummarize = vi.fn();
    const secondSummarize = vi.fn();
    const view = createSummarizeControlView({
      root: {} as HTMLElement,
      panelState: createInitialPanelState(),
      slidesTextController: {
        getTextMode: () => "transcript",
        getTextToggleVisible: () => false,
      },
    });

    view.refresh();
    expect(currentProps).toBeNull();

    view.bindActions({
      onSlidesTextModeChange: vi.fn(),
      onChange: vi.fn(),
      onSummarize: firstSummarize,
    });
    view.bindActions({
      onSlidesTextModeChange: vi.fn(),
      onChange: vi.fn(),
      onSummarize: secondSummarize,
    });
    currentProps?.onSummarize();

    expect(firstSummarize).toHaveBeenCalledOnce();
    expect(secondSummarize).not.toHaveBeenCalled();
  });

  it("refreshes the mounted control from canonical panel state", () => {
    const { state, view } = buildRuntime();
    state.slidesSession.inputMode = "video";
    state.slidesSession.slidesEnabled = true;
    state.slidesSession.slidesBusy = true;

    view.refresh();

    expect(summarizeControlUpdate).toHaveBeenCalledOnce();
    expect(currentProps).toMatchObject({
      mode: "video",
      slidesEnabled: true,
      busy: true,
    });
  });

  it("blocks enabling slides when required tools are missing", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({
        ok: true,
        tools: {
          ytDlp: { available: true },
          ffmpeg: { available: false },
          tesseract: { available: true },
        },
      }),
    } as Response);
    const { state, calls } = buildRuntime({
      settings: { slideRuntime: "daemon", token: "token" },
    });

    await currentProps?.onChange({ mode: "video", slides: true });

    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(calls.showSlideNotice).toHaveBeenCalledWith(
      "Slide extraction requires ffmpeg. Install and restart the daemon.",
    );
    expect(calls.patchSettings).not.toHaveBeenCalled();
    expect(state.slidesSession.slidesEnabled).toBe(false);
  });

  it("enables browser runtime slides without daemon tool checks", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const { state, calls } = buildRuntime({
      settings: { slideRuntime: "browser", token: "" },
    });

    await currentProps?.onChange({ mode: "video", slides: true });

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(calls.showSlideNotice).not.toHaveBeenCalled();
    expect(calls.hideSlideNotice).toHaveBeenCalledOnce();
    expect(calls.patchSettings).toHaveBeenCalledWith({ slidesEnabled: true });
    expect(state.slidesSession.slidesEnabled).toBe(true);
  });

  it("disabling slides stops active work and persists the setting", async () => {
    const { state, calls } = buildRuntime({
      state: {
        slidesEnabled: true,
        slidesBusy: true,
        autoSummarize: true,
        inputMode: "video",
      },
    });

    await currentProps?.onChange({ mode: "page", slides: false });

    expect(calls.hideSlideNotice).toHaveBeenCalledOnce();
    expect(calls.setSlidesBusy).toHaveBeenCalledWith(false);
    expect(calls.stopSlidesStream).toHaveBeenCalledOnce();
    expect(calls.patchSettings).toHaveBeenCalledWith({ slidesEnabled: false });
    expect(calls.sendSummarize).toHaveBeenCalledWith({ refresh: true });
    expect(state.slidesSession.slidesEnabled).toBe(false);
    expect(state.slidesSession.inputModeOverride).toBe("page");
  });

  it("retries existing slide streams instead of re-summarizing", () => {
    const { calls, runtime } = buildRuntime({
      state: { slidesEnabled: true, currentSourceUrl: "https://example.com/current" },
      resolveActiveSlidesRunId: () => "slides-run-1",
    });

    runtime.retrySlidesStream();

    expect(calls.hideSlideNotice).toHaveBeenCalledOnce();
    expect(calls.startSlidesStreamForRunId).toHaveBeenCalledWith("slides-run-1");
    expect(calls.startSlidesSummaryStreamForRunId).toHaveBeenCalledWith(
      "slides-run-1",
      "https://example.com/current",
    );
    expect(calls.sendSummarize).not.toHaveBeenCalled();
  });

  it("retries local browser slide streams without daemon summary streaming", () => {
    const { calls, runtime } = buildRuntime({
      state: { slidesEnabled: true, currentSourceUrl: "https://example.com/current" },
      resolveActiveSlidesRunId: () => "browser-slides-run",
      isActiveSlidesRunLocal: (runId) => runId === "browser-slides-run",
    });

    runtime.retrySlidesStream();

    expect(calls.startSlidesStreamForRunId).toHaveBeenCalledWith("browser-slides-run");
    expect(calls.startSlidesSummaryStreamForRunId).not.toHaveBeenCalled();
    expect(calls.sendSummarize).not.toHaveBeenCalled();
  });

  it("refreshes summarize when retrying slides without an active run", () => {
    const { calls, runtime } = buildRuntime({
      state: { slidesEnabled: true },
    });

    runtime.retrySlidesStream();

    expect(calls.sendSummarize).toHaveBeenCalledWith({ refresh: true });
    expect(calls.startSlidesStreamForRunId).not.toHaveBeenCalled();
  });

  it("switches slide text mode through fallback rendering when summary markdown exists", () => {
    const { calls, slidesTextController } = buildRuntime({
      state: { hasSummaryMarkdown: true },
    });

    currentProps?.onSlidesTextModeChange?.("ocr");

    expect(slidesTextController.setTextMode).toHaveBeenCalledWith("ocr");
    expect(calls.renderInlineSlidesFallback).toHaveBeenCalledOnce();
    expect(calls.queueSlidesRender).not.toHaveBeenCalled();
  });

  it("queues slides render when switching text mode without summary markdown", () => {
    const { calls, runtime, renderMarkdownHostEl, renderSlidesHostEl } = buildRuntime({
      state: { hasSummaryMarkdown: false, slidesEnabled: true, inputMode: "video" },
    });

    currentProps?.onSlidesTextModeChange?.("ocr");
    runtime.applySlidesLayout();

    expect(calls.queueSlidesRender).toHaveBeenCalledOnce();
    expect(calls.renderInlineSlidesFallback).not.toHaveBeenCalled();
    expect(renderMarkdownHostEl.classList.remove).toHaveBeenCalledWith("hidden");
    expect(renderSlidesHostEl.dataset.layout).toBe("gallery");
  });
});
