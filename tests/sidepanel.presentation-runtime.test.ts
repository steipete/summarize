import { readFileSync } from "node:fs";
// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSidepanelDom } from "../apps/chrome-extension/src/entrypoints/sidepanel/dom";
import { createMetricsController } from "../apps/chrome-extension/src/entrypoints/sidepanel/metrics-controller";
import { createInitialPanelState } from "../apps/chrome-extension/src/entrypoints/sidepanel/panel-state-store";
import { createSidepanelPresentationRuntime } from "../apps/chrome-extension/src/entrypoints/sidepanel/presentation-runtime";

vi.mock("../apps/chrome-extension/src/entrypoints/sidepanel/pickers", () => ({
  mountSummarizeControl: (
    root: HTMLElement,
    props: {
      onSummarize: () => void;
    },
  ) => {
    const button = document.createElement("button");
    button.addEventListener("click", props.onSummarize);
    root.append(button);
    return { update: vi.fn() };
  },
}));

const sidepanelHtml = readFileSync(
  "apps/chrome-extension/src/entrypoints/sidepanel/index.html",
  "utf8",
);
const sidepanelBody =
  sidepanelHtml.match(/<body>([\s\S]*)<\/body>/)?.[1]?.replace(/<script[\s\S]*?<\/script>/g, "") ??
  "";

describe("sidepanel presentation runtime", () => {
  beforeEach(() => {
    document.body.innerHTML = sidepanelBody;
  });

  it("composes controls, summary dispatch, and deferred feedback actions", async () => {
    const dom = createSidepanelDom();
    const store = createInitialPanelState();
    const send = vi.fn(async () => {});
    const runtime = createSidepanelPresentationRuntime({
      dom,
      panelState: store,

      appearanceControls: {
        getLengthValue: () => "medium",
      },
      metricsController: createMetricsController({
        metricsEl: dom.metricsEl,
        metricsHomeEl: dom.metricsHomeEl,
        chatMetricsSlotEl: dom.chatMetricsSlotEl,
      }),
      resolveLocalSlides: vi.fn(async () => null),
      send,
    });

    expect(dom.summarizeControlRoot.childElementCount).toBeGreaterThan(0);

    dom.summarizeControlRoot.querySelector("button")?.click();
    await Promise.resolve();

    expect(store.panelSession.lastAction).toBe("summarize");
    expect(send).toHaveBeenCalledWith({
      type: "panel:summarize",
      refresh: false,
      inputMode: undefined,
    });

    const retryLastAction = vi.fn();
    runtime.feedback.bindActions(retryLastAction);
    runtime.feedback.errorController.showPanelError("Failure");
    dom.errorRetryBtn.click();

    expect(retryLastAction).toHaveBeenCalledOnce();
  });
});
