import { describe, expect, it } from "vitest";
import { createInitialPanelState } from "../apps/chrome-extension/src/entrypoints/sidepanel/panel-state-store";
import {
  retainRenderedSlideSummary,
  selectRetainedSlideSummaryMarkdown,
} from "../apps/chrome-extension/src/entrypoints/sidepanel/retained-slide-summary";

describe("retained slide summary", () => {
  it("retains non-empty rendered markdown for the current source only", () => {
    const store = createInitialPanelState();
    store.currentSource = {
      url: "https://example.com/watch?v=1#chapter",
      title: "Example",
    };

    expect(selectRetainedSlideSummaryMarkdown(store)).toBeNull();
    retainRenderedSlideSummary(store, "  ");
    expect(store.retainedSlideSummary).toBeNull();

    retainRenderedSlideSummary(store, "# Summary");
    expect(selectRetainedSlideSummaryMarkdown(store)).toBe("# Summary");

    store.currentSource = { url: "https://example.com/other", title: "Other" };
    expect(selectRetainedSlideSummaryMarkdown(store)).toBeNull();
  });

  it("uses the active tab as the retained-summary scope fallback", () => {
    const store = createInitialPanelState();
    store.navigation.activeTabUrl = "https://example.com/watch?v=1";

    retainRenderedSlideSummary(store, "Summary");

    expect(store.retainedSlideSummary).toEqual({
      markdown: "Summary",
      url: "https://example.com/watch?v=1",
    });
    store.navigation.activeTabUrl = null;
    expect(selectRetainedSlideSummaryMarkdown(store)).toBe("Summary");
  });
});
