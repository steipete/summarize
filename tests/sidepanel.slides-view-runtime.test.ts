// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createInitialPanelState } from "../apps/chrome-extension/src/entrypoints/sidepanel/panel-state-store";
import { createSlidesViewRuntime } from "../apps/chrome-extension/src/entrypoints/sidepanel/slides-view-runtime";
import type { PanelState } from "../apps/chrome-extension/src/entrypoints/sidepanel/types";

const mocks = vi.hoisted(() => ({
  observeSlideImage: vi.fn(),
  logExtensionEvent: vi.fn(),
}));

vi.mock(
  "../apps/chrome-extension/src/entrypoints/sidepanel/slide-images",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("../apps/chrome-extension/src/entrypoints/sidepanel/slide-images")
      >();
    return {
      ...actual,
      createSlideImageLoader: () => ({
        observe: mocks.observeSlideImage,
        clearCache: vi.fn(),
      }),
    };
  },
);

vi.mock("../apps/chrome-extension/src/lib/extension-logs", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../apps/chrome-extension/src/lib/extension-logs")>();
  return { ...actual, logExtensionEvent: mocks.logExtensionEvent };
});

function createSlidePayload(
  overrides: Partial<NonNullable<PanelState["slides"]>> = {},
): NonNullable<PanelState["slides"]> {
  return {
    sourceUrl: "https://example.com/video",
    sourceId: "slides-1",
    sourceKind: "youtube",
    ocrAvailable: false,
    slides: [{ index: 1, timestamp: 0, imageUrl: "", ocrText: "" }],
    ...overrides,
  };
}

function createHarness(
  options: {
    dispatch?: boolean;
    fallbackSummary?: string | null;
    panelState?: PanelState;
    summaryChanged?: boolean;
    titles?: Map<number, string>;
  } = {},
) {
  const panelState = options.panelState ?? createInitialPanelState();
  panelState.currentSource ??= { url: "https://example.com/video", title: "Video" };
  panelState.slides ??= createSlidePayload();
  const store = panelState;
  const send = vi.fn(async () => {});
  const refreshSummarizeControl = vi.fn();
  const headerSetProgressOverride = vi.fn();
  const renderMarkdownHostEl = document.createElement("div");
  const renderSlidesHostEl = document.createElement("div");
  const chatMessagesEl = document.createElement("div");
  const scheduleSync = vi.fn();
  const hideSlideNotice = vi.fn();
  const rebuildDescriptions = vi.fn();
  const syncTextState = vi.fn();
  const updateSummaryFromMarkdown = vi.fn(() => options.summaryChanged ?? false);
  const runtime = createSlidesViewRuntime({
    renderMarkdownHostEl,
    renderSlidesHostEl,
    summaryCopyBtn: document.createElement("button"),
    chatMessagesEl,
    md: { render: (value: string) => `<p>${value}</p>` } as never,
    headerSetStatus: vi.fn(),
    headerSetProgressOverride,
    slidesTextController: {
      hasSummaryTitles: vi.fn(() => false),
      updateSummaryFromMarkdown,
      rebuildDescriptions,
      syncTextState,
      getDescriptions: vi.fn(() => new Map([[1, "Description"]])),
      getTitles: vi.fn(() => options.titles ?? new Map()),
      getDescriptionEntries: vi.fn(() => []),
      getTranscriptTimedText: vi.fn(() => null),
    },
    panelCacheController: { scheduleSync },
    send,
    refreshSummarizeControl,
    hideSlideNotice,
    panelState,

    getFallbackSummaryMarkdown: () => options.fallbackSummary ?? null,
  });
  return {
    chatMessagesEl,
    headerSetProgressOverride,
    hideSlideNotice,
    panelState,
    rebuildDescriptions,
    refreshSummarizeControl,
    renderMarkdownHostEl,
    renderSlidesHostEl,
    runtime,
    scheduleSync,
    send,
    syncTextState,
    updateSummaryFromMarkdown,
  };
}

describe("slides view runtime", () => {
  beforeEach(() => {
    document.body.replaceChildren();
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it("updates busy UI from canonical panel state and skips duplicate transitions", () => {
    const toggle = document.createElement("button");
    toggle.className = "summarizeSlideToggle";
    document.body.append(toggle);
    const harness = createHarness();

    harness.runtime.setSlidesBusy(true);
    harness.runtime.setSlidesBusy(true);
    toggle.remove();
    harness.runtime.setSlidesBusy(false);

    expect(harness.panelState.slidesSession.slidesBusy).toBe(false);
    expect(toggle.dataset.busy).toBe("true");
    expect(harness.headerSetProgressOverride).toHaveBeenCalledTimes(2);
    expect(harness.refreshSummarizeControl).toHaveBeenCalledTimes(2);
  });

  it("owns context request identity and deduplicates pending requests", async () => {
    const harness = createHarness();

    await harness.runtime.requestSlidesContext();
    await harness.runtime.requestSlidesContext();

    expect(harness.panelState.slidesSession).toMatchObject({
      slidesContextPending: true,
      slidesContextRequestId: 1,
      slidesContextUrl: "https://example.com/video",
    });
    expect(harness.send).toHaveBeenCalledOnce();
    expect(harness.send).toHaveBeenCalledWith({
      type: "panel:slides-context",
      requestId: "slides-1",
      url: "https://example.com/video",
    });
  });

  it("guards missing, pending, and already-loaded slide context", async () => {
    const noSlides = createHarness();
    noSlides.panelState.slides = null;
    await noSlides.runtime.requestSlidesContext();

    const pending = createHarness();
    pending.panelState.slidesSession.slidesContextPending = true;
    await pending.runtime.requestSlidesContext();

    const loaded = createHarness();
    loaded.panelState.slidesSession.slidesContextUrl = "https://example.com/video";
    await loaded.runtime.requestSlidesContext();

    expect(noSlides.send).not.toHaveBeenCalled();
    expect(pending.send).not.toHaveBeenCalled();
    expect(loaded.send).not.toHaveBeenCalled();
  });

  it("sends context requests without a URL when no source URL exists", async () => {
    const panelState = createInitialPanelState();
    panelState.slides = createSlidePayload({ sourceUrl: "" });
    const harness = createHarness({ panelState });
    harness.panelState.currentSource = null;

    await harness.runtime.requestSlidesContext();

    expect(harness.send).toHaveBeenCalledWith({
      type: "panel:slides-context",
      requestId: "slides-1",
      url: undefined,
    });
  });

  it("renders slide metadata, image loading, and seek effects from canonical state", () => {
    const panelState = createInitialPanelState();
    panelState.slidesSession.inputMode = "video";
    panelState.slidesSession.slidesEnabled = true;
    panelState.slides = createSlidePayload({
      slides: [
        {
          index: 1,
          timestamp: 65,
          imageUrl: "https://example.com/1.png",
          ocrText: "Intro",
        },
        { index: 2, timestamp: Number.NaN, imageUrl: "", ocrText: "Details" },
      ],
    });
    const harness = createHarness({
      panelState,
      titles: new Map([
        [1, "Intro"],
        [2, "Details"],
      ]),
    });

    harness.runtime.slidesRenderer.forceRender();
    const items =
      harness.renderSlidesHostEl.querySelectorAll<HTMLButtonElement>(".slideGallery__item");
    items[0]?.click();
    items[1]?.click();

    expect(items).toHaveLength(2);
    expect(items[0]?.textContent).toContain("Intro · 1:05");
    expect(items[1]?.textContent).toContain("Details");
    expect(mocks.observeSlideImage).toHaveBeenCalledWith(
      expect.any(HTMLImageElement),
      "https://example.com/1.png",
    );
    expect(harness.send).toHaveBeenCalledOnce();
    expect(harness.send).toHaveBeenCalledWith({ type: "panel:seek", seconds: 65 });
  });

  it("writes rendered markdown through an injected panel dispatcher", () => {
    const harness = createHarness({ dispatch: true, summaryChanged: true });

    harness.runtime.renderMarkdown("Updated summary");

    expect(harness.panelState.summaryMarkdown).toBe("Updated summary");
    expect(harness.updateSummaryFromMarkdown).toHaveBeenCalledWith("Updated summary", {
      preserveIfEmpty: false,
      source: "summary",
    });
    expect(harness.renderMarkdownHostEl.innerHTML).toContain("Updated summary");
    expect(harness.scheduleSync).toHaveBeenCalledOnce();
  });

  it("renders empty state from navigation and UI fallbacks", () => {
    const panelState = createInitialPanelState();
    panelState.navigation.activeTabUrl = "https://example.com/fallback";
    panelState.panelSession.autoSummarize = true;
    panelState.currentSource = null;
    panelState.slides = null;
    const harness = createHarness({ panelState });
    harness.panelState.currentSource = null;
    harness.panelState.slides = null;

    harness.runtime.renderEmptySummaryState();
    harness.runtime.renderMarkdownDisplay();

    expect(harness.renderMarkdownHostEl.textContent).toContain("Loading");
  });

  it("applies a seeded payload with transcript and fallback summary", () => {
    const panelState = createInitialPanelState();
    panelState.slides = createSlidePayload();
    panelState.slidesRunId = "slides-run";
    panelState.slidesSession.slidesSeededSourceId = "slides-1";
    const harness = createHarness({
      fallbackSummary: "Fallback summary",
      panelState,
      summaryChanged: true,
    });
    const setTranscript = vi.fn();

    harness.runtime.applySlidesPayload(
      createSlidePayload({
        transcriptTimedText: "[00:01] Intro",
        slideRuntime: "browser",
        ocrAvailable: true,
        slides: [
          {
            index: 1,
            timestamp: 1,
            imageUrl: "http://127.0.0.1:8787/v1/summarize/run/slides/1",
            ocrText: "Intro",
          },
        ],
      }),
      setTranscript,
    );

    expect(harness.panelState.slidesSession).toMatchObject({
      slidesAppliedRunId: "slides-run",
      slidesContextPending: false,
      slidesContextUrl: "https://example.com/video",
      slidesSeededSourceId: null,
    });
    expect(harness.panelState.slides?.slides[0]?.imageUrl).toBe(
      "http://127.0.0.1:8787/v1/slides/slides-1/1",
    );
    expect(setTranscript).toHaveBeenCalledWith("[00:01] Intro");
    expect(harness.updateSummaryFromMarkdown).toHaveBeenCalledWith("Fallback summary", {
      preserveIfEmpty: true,
      source: "summary",
    });
    expect(harness.hideSlideNotice).toHaveBeenCalledOnce();
    expect(harness.scheduleSync).toHaveBeenCalledOnce();
  });

  it("clears stale transcript state and requests context for a new page-derived source", () => {
    const panelState = createInitialPanelState();
    panelState.runId = "summary-run";
    panelState.slides = createSlidePayload({ sourceId: "old-slides" });
    panelState.slidesSession.slidesContextPending = true;
    panelState.slidesSession.slidesContextUrl = "https://example.com/old";
    const harness = createHarness({ panelState });
    const setTranscript = vi.fn();

    harness.runtime.applySlidesPayload(
      createSlidePayload({
        sourceId: "page-new",
        sourceUrl: "https://example.com/new",
      }),
      setTranscript,
    );

    expect(setTranscript).toHaveBeenCalledWith(null);
    expect(harness.panelState.slidesSession.slidesAppliedRunId).toBe("summary-run");
    expect(harness.panelState.slidesSession.slidesContextPending).toBe(true);
    expect(harness.send).toHaveBeenCalledWith({
      type: "panel:slides-context",
      requestId: "slides-1",
      url: "https://example.com/new",
    });
  });

  it("marks an unchanged payload as applied without rerendering", () => {
    const panelState = createInitialPanelState();
    panelState.slidesRunId = "slides-run";
    panelState.slides = createSlidePayload();
    panelState.slidesSession.slidesAppliedRunId = "slides-run";
    const harness = createHarness({ panelState });
    const setTranscript = vi.fn();

    harness.runtime.applySlidesPayload(createSlidePayload(), setTranscript);

    expect(harness.panelState.slidesSession.slidesAppliedRunId).toBe("slides-run");
    expect(setTranscript).not.toHaveBeenCalled();
    expect(harness.scheduleSync).not.toHaveBeenCalled();
  });

  it("ignores invalid payloads and does not request context for preferred URL mode", () => {
    const panelState = createInitialPanelState();
    panelState.slides = createSlidePayload({ sourceId: "old-slides" });
    const harness = createHarness({ panelState });
    const setTranscript = vi.fn();

    harness.runtime.applySlidesPayload({} as never, setTranscript);
    harness.runtime.applySlidesPayload(
      createSlidePayload({
        sourceId: "youtube-slides",
        sourceUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      }),
      setTranscript,
    );

    expect(harness.send).not.toHaveBeenCalled();
    expect(harness.panelState.slides?.sourceId).toBe("youtube-slides");
  });

  it("logs payload metadata when extension storage is available", () => {
    vi.stubGlobal("chrome", { storage: {} });
    const harness = createHarness();

    harness.runtime.applySlidesPayload(
      createSlidePayload({ sourceId: "logged-slides", slideRuntime: "daemon" }),
      vi.fn(),
    );

    expect(mocks.logExtensionEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "slides:payload:applied",
        detail: expect.objectContaining({ slideRuntime: "daemon" }),
      }),
    );
  });
});
