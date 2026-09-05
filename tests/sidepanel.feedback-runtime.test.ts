import { beforeEach, describe, expect, it, vi } from "vitest";
// @vitest-environment happy-dom
import { createSidepanelFeedbackRuntime } from "../apps/chrome-extension/src/entrypoints/sidepanel/feedback-runtime";
import { createInitialPanelState } from "../apps/chrome-extension/src/entrypoints/sidepanel/panel-state-store";
import { createPanelPhaseRuntime } from "../apps/chrome-extension/src/entrypoints/sidepanel/phase-runtime";

function createHarness(options: { storageThrows?: boolean } = {}) {
  const store = createInitialPanelState();
  const headerEl = document.createElement("header");
  headerEl.getBoundingClientRect = () => ({ height: 64 }) as DOMRect;
  const titleEl = document.createElement("div");
  const subtitleEl = document.createElement("div");
  const progressFillEl = document.createElement("div");
  headerEl.append(titleEl, subtitleEl, progressFillEl);
  const panelErrorEl = document.createElement("div");
  panelErrorEl.className = "hidden";
  const panelErrorMessageEl = document.createElement("div");
  const panelErrorRetryBtn = document.createElement("button");
  const panelErrorLogsBtn = document.createElement("button");
  panelErrorEl.append(panelErrorMessageEl, panelErrorRetryBtn, panelErrorLogsBtn);
  const inlineErrorEl = document.createElement("div");
  inlineErrorEl.className = "hidden";
  const inlineErrorMessageEl = document.createElement("div");
  const inlineErrorRetryBtn = document.createElement("button");
  const inlineErrorLogsBtn = document.createElement("button");
  const inlineErrorCloseBtn = document.createElement("button");
  inlineErrorEl.append(
    inlineErrorMessageEl,
    inlineErrorRetryBtn,
    inlineErrorLogsBtn,
    inlineErrorCloseBtn,
  );
  const slideNoticeEl = document.createElement("div");
  slideNoticeEl.className = "hidden";
  const slideNoticeMessageEl = document.createElement("span");
  const slideNoticeRetryBtn = document.createElement("button");
  slideNoticeEl.append(slideNoticeMessageEl, slideNoticeRetryBtn);
  document.body.append(headerEl, panelErrorEl, inlineErrorEl, slideNoticeEl);

  const listeners = new Map<string, EventListener>();
  const retryLastAction = vi.fn();
  const retrySlidesStream = vi.fn();
  const sendOpenOptions = vi.fn();
  const setSlidesBusy = vi.fn();
  const rebuildSlideDescriptions = vi.fn();
  const queueSlidesRender = vi.fn();
  const storage = {
    setItem: options.storageThrows
      ? vi.fn(() => {
          throw new Error("blocked");
        })
      : vi.fn(),
  };
  const runtime = createSidepanelFeedbackRuntime({
    panelState: store,
    headerEl,
    titleEl,
    subtitleEl,
    progressFillEl,
    panelErrorEl,
    panelErrorMessageEl,
    panelErrorRetryBtn,
    panelErrorLogsBtn,
    inlineErrorEl,
    inlineErrorMessageEl,
    inlineErrorRetryBtn,
    inlineErrorLogsBtn,
    inlineErrorCloseBtn,
    slideNoticeEl,
    slideNoticeMessageEl,
    slideNoticeRetryBtn,
    sendOpenOptions,
    eventTarget: {
      addEventListener: (type, listener) => {
        listeners.set(type, listener);
      },
    },
    storage,
  });
  runtime.bindActions({ retryLastAction, retrySlidesStream });
  const phaseRuntime = createPanelPhaseRuntime({
    panelState: store,

    errorController: runtime.errorController,
    headerController: runtime.headerController,
    setSlidesBusy,
    rebuildSlideDescriptions,
    queueSlidesRender,
    eventTarget: {
      addEventListener: (type, listener) => {
        listeners.set(type, listener);
      },
    },
  });

  return {
    inlineErrorCloseBtn,
    inlineErrorEl,
    inlineErrorLogsBtn,
    inlineErrorMessageEl,
    inlineErrorRetryBtn,
    listeners,
    panelErrorEl,
    panelErrorLogsBtn,
    panelErrorMessageEl,
    panelErrorRetryBtn,
    phaseRuntime,
    queueSlidesRender,
    rebuildSlideDescriptions,
    retryLastAction,
    retrySlidesStream,
    runtime,
    sendOpenOptions,
    setSlidesBusy,
    slideNoticeEl,
    slideNoticeMessageEl,
    slideNoticeRetryBtn,
    storage,
    store,
    subtitleEl,
  };
}

describe("sidepanel feedback runtime", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    document.documentElement.style.removeProperty("--header-height");
  });

  it("owns slide notices and retry actions", () => {
    const harness = createHarness();

    expect(document.documentElement.style.getPropertyValue("--header-height")).toBe("64px");
    harness.runtime.showSlideNotice("Slides unavailable", { allowRetry: true });
    expect(harness.slideNoticeEl.classList.contains("hidden")).toBe(false);
    expect(harness.slideNoticeMessageEl.textContent).toBe("Slides unavailable");
    expect(harness.slideNoticeRetryBtn.hidden).toBe(false);

    harness.slideNoticeRetryBtn.click();
    expect(harness.retrySlidesStream).toHaveBeenCalledOnce();

    harness.runtime.hideSlideNotice();
    expect(harness.slideNoticeEl.classList.contains("hidden")).toBe(true);
    expect(harness.slideNoticeMessageEl.textContent).toBe("");
    expect(harness.slideNoticeRetryBtn.hidden).toBe(true);
  });

  it("keeps phase, error, progress, and slide render effects synchronized", () => {
    const harness = createHarness();

    harness.phaseRuntime.setPhase("connecting");
    expect(harness.store.phase).toBe("connecting");
    expect(harness.setSlidesBusy).not.toHaveBeenCalled();

    harness.phaseRuntime.setPhase("idle");
    expect(harness.setSlidesBusy).toHaveBeenCalledWith(false);
    expect(harness.rebuildSlideDescriptions).not.toHaveBeenCalled();

    harness.store.slides = { slides: [] } as never;
    harness.phaseRuntime.setPhase("streaming");
    harness.phaseRuntime.setPhase("idle");
    expect(harness.rebuildSlideDescriptions).toHaveBeenCalledOnce();
    expect(harness.queueSlidesRender).toHaveBeenCalledOnce();

    harness.phaseRuntime.setPhase("error", { error: "Failure" });
    expect(harness.store.error).toBe("Failure");
    expect(harness.panelErrorMessageEl.textContent).toBe("Failure");
    expect(harness.panelErrorEl.classList.contains("hidden")).toBe(false);
    expect(harness.setSlidesBusy).toHaveBeenLastCalledWith(false);

    harness.phaseRuntime.setPhase("error", { error: "" });
    expect(harness.panelErrorMessageEl.textContent).toBe("Something went wrong.");
  });

  it("routes panel and inline retry/log controls", () => {
    const harness = createHarness();

    harness.panelErrorRetryBtn.click();
    harness.inlineErrorRetryBtn.click();
    expect(harness.retryLastAction).toHaveBeenCalledTimes(2);

    harness.panelErrorLogsBtn.click();
    harness.inlineErrorLogsBtn.click();
    expect(harness.storage.setItem).toHaveBeenCalledTimes(2);
    expect(harness.storage.setItem).toHaveBeenCalledWith("summarize:options-tab", "logs");
    expect(harness.sendOpenOptions).toHaveBeenCalledTimes(2);

    harness.runtime.errorController.showInlineError("Inline failure");
    expect(harness.inlineErrorMessageEl.textContent).toBe("Inline failure");
    harness.inlineErrorCloseBtn.click();
    expect(harness.inlineErrorEl.classList.contains("hidden")).toBe(true);
  });

  it("still opens options when local storage is unavailable", () => {
    const harness = createHarness({ storageThrows: true });

    harness.panelErrorLogsBtn.click();

    expect(harness.sendOpenOptions).toHaveBeenCalledOnce();
  });

  it("captures global errors and rejected promises", () => {
    const harness = createHarness();
    const errorListener = harness.listeners.get("error");
    const rejectionListener = harness.listeners.get("unhandledrejection");

    errorListener?.(
      new ErrorEvent("error", {
        error: new Error("window failure"),
        message: "fallback",
      }),
    );
    expect(harness.store.phase).toBe("error");
    expect(harness.store.error).toContain("window failure");
    expect(harness.panelErrorMessageEl.textContent).toContain("window failure");

    errorListener?.(new ErrorEvent("error", { message: "message-only failure" }));
    expect(harness.store.error).toBe("message-only failure");

    rejectionListener?.({
      reason: new Error("promise failure"),
    } as PromiseRejectionEvent);
    expect(harness.store.error).toContain("promise failure");

    rejectionListener?.({ reason: "rejected" } as PromiseRejectionEvent);
    expect(harness.store.error).toBe("rejected");
    expect(harness.panelErrorMessageEl.textContent).toBe("rejected");
  });
});
