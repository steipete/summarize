import { describe, expect, it } from "vitest";
import { buildSummaryEmptyState } from "../apps/chrome-extension/src/entrypoints/sidepanel/summary-empty-state.js";

describe("sidepanel summary empty state", () => {
  it("shows a ready state for manual summarize", () => {
    expect(
      buildSummaryEmptyState({
        tabTitle: "Example Video",
        tabUrl: "https://www.youtube.com/watch?v=abc",
        autoSummarize: false,
        phase: "idle",
        hasSlides: false,
      }),
    ).toEqual({
      title: "Ready to summarize",
      message: "Click Summarize to analyze Example Video.",
    });
  });

  it("shows a loading state when auto summarize is active", () => {
    expect(
      buildSummaryEmptyState({
        tabTitle: "Example Video",
        tabUrl: "https://www.youtube.com/watch?v=abc",
        autoSummarize: true,
        phase: "idle",
        hasSlides: false,
      }),
    ).toEqual({
      title: "Summarizing this page...",
      message: "Waiting for Example Video.",
    });
  });

  it("hides the empty state once slides exist", () => {
    expect(
      buildSummaryEmptyState({
        tabTitle: "Example Video",
        tabUrl: "https://www.youtube.com/watch?v=abc",
        autoSummarize: false,
        phase: "idle",
        hasSlides: true,
      }),
    ).toBeNull();
  });
});
