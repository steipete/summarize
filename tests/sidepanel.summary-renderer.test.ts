// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";
import {
  renderSummaryEmptyState,
  renderSummaryMarkdownDisplay,
} from "../apps/chrome-extension/src/entrypoints/sidepanel/summary-renderer.js";

describe("sidepanel summary renderer", () => {
  function createHeaderCopyButton() {
    const button = document.createElement("button");
    button.className = "hidden";
    return button;
  }

  it("renders and clears empty states", () => {
    const hostEl = document.createElement("div");
    renderSummaryEmptyState({
      hostEl,
      state: { label: "Loading", message: "Preparing summary", detail: "Video title" },
    });
    expect(hostEl.textContent).toContain("Loading");
    expect(hostEl.textContent).toContain("Preparing summary");
    expect(hostEl.textContent).toContain("Video title");

    renderSummaryEmptyState({ hostEl, state: null });
    expect(hostEl.innerHTML).toBe("");
  });

  it("renders empty states without an optional detail line", () => {
    const hostEl = document.createElement("div");
    renderSummaryEmptyState({
      hostEl,
      state: { label: "Ready", message: "Click Summarize to start.", detail: "" },
    });
    expect(hostEl.querySelector(".renderEmpty__detail")).toBeNull();
  });

  it("renders markdown links and timestamp anchors", () => {
    const hostEl = document.createElement("div");
    const copyButtonEl = createHeaderCopyButton();
    const renderInlineSlides = vi.fn();
    renderSummaryMarkdownDisplay({
      activeTabUrl: "https://example.com/watch",
      autoSummarize: false,
      currentSourceTitle: "Video",
      currentSourceUrl: "https://example.com/watch",
      hasSlides: false,
      headerSetStatus: vi.fn(),
      hostEl,
      copyButtonEl,
      inputMode: "video",
      markdown: "[00:10] intro\n\n[link](https://example.com)",
      md: {
        render: (value) =>
          value
            .replace("[00:10](timestamp:10)", '<a href="timestamp:10">00:10</a>')
            .replace("[link](https://example.com)", '<a href="https://example.com">link</a>'),
      },
      phase: "done",
      renderInlineSlides,
      slidesEnabled: false,
      slidesLayout: "gallery",
      tabTitle: "Video",
      tabUrl: "https://example.com/watch",
    });

    const links = Array.from(hostEl.querySelectorAll("a"));
    expect(links[0]?.classList.contains("chatTimestamp")).toBe(true);
    expect(links[0]?.getAttribute("target")).toBeNull();
    expect(links[1]?.getAttribute("target")).toBe("_blank");
    expect(renderInlineSlides).toHaveBeenCalledWith(hostEl, { fallback: true });
    expect(hostEl.querySelector(".render__copy")).toBeNull();
    expect(copyButtonEl.classList.contains("hidden")).toBe(false);
  });

  it("copies rendered markdown text to the clipboard", async () => {
    const hostEl = document.createElement("div");
    const copyButtonEl = createHeaderCopyButton();
    const setStatus = vi.fn();
    const writeText = vi.fn(async () => {});
    Object.assign(navigator, {
      clipboard: {
        writeText,
      },
    });

    renderSummaryMarkdownDisplay({
      activeTabUrl: "https://example.com/watch",
      autoSummarize: false,
      currentSourceTitle: "Video",
      currentSourceUrl: "https://example.com/watch",
      hasSlides: false,
      headerSetStatus: setStatus,
      hostEl,
      copyButtonEl,
      inputMode: "video",
      markdown: "# Title\n\nBody",
      md: { render: (value) => `<p>${value}</p>` },
      phase: "done",
      renderInlineSlides: vi.fn(),
      slidesEnabled: false,
      slidesLayout: "gallery",
      tabTitle: "Video",
      tabUrl: "https://example.com/watch",
    });

    copyButtonEl.click();
    await Promise.resolve();

    expect(writeText).toHaveBeenCalledWith("# Title\n\nBody");
    expect(setStatus).toHaveBeenCalledWith("Copied");
  });

  it("reports empty copy attempts without touching the clipboard", async () => {
    const hostEl = document.createElement("div");
    const copyButtonEl = createHeaderCopyButton();
    const setStatus = vi.fn();
    const writeText = vi.fn(async () => {});
    Object.assign(navigator, {
      clipboard: {
        writeText,
      },
    });

    renderSummaryMarkdownDisplay({
      activeTabUrl: "https://example.com/watch",
      autoSummarize: false,
      currentSourceTitle: "Video",
      currentSourceUrl: "https://example.com/watch",
      hasSlides: false,
      headerSetStatus: setStatus,
      hostEl,
      copyButtonEl,
      inputMode: "video",
      markdown: "   ",
      md: { render: (value) => `<p>${value}</p>` },
      phase: "done",
      renderInlineSlides: vi.fn(),
      slidesEnabled: false,
      slidesLayout: "gallery",
      tabTitle: "Video",
      tabUrl: "https://example.com/watch",
    });

    expect(hostEl.textContent).toContain("Summarize");
    expect(copyButtonEl.classList.contains("hidden")).toBe(true);
    expect(writeText).not.toHaveBeenCalled();
    expect(setStatus).not.toHaveBeenCalledWith("Copied");
  });

  it("falls back to execCommand copy when clipboard write fails", async () => {
    const hostEl = document.createElement("div");
    const copyButtonEl = createHeaderCopyButton();
    const setStatus = vi.fn();
    const writeText = vi.fn(async () => {
      throw new Error("blocked");
    });
    const execCommand = vi.fn(() => true);
    Object.assign(navigator, {
      clipboard: {
        writeText,
      },
    });
    Object.assign(document, { execCommand });

    renderSummaryMarkdownDisplay({
      activeTabUrl: "https://example.com/watch",
      autoSummarize: false,
      currentSourceTitle: "Video",
      currentSourceUrl: "https://example.com/watch",
      hasSlides: false,
      headerSetStatus: setStatus,
      hostEl,
      copyButtonEl,
      inputMode: "video",
      markdown: "Body",
      md: { render: (value) => `<p>${value}</p>` },
      phase: "done",
      renderInlineSlides: vi.fn(),
      slidesEnabled: false,
      slidesLayout: "gallery",
      tabTitle: "Video",
      tabUrl: "https://example.com/watch",
    });

    copyButtonEl.click();
    await Promise.resolve();

    expect(execCommand).toHaveBeenCalledWith("copy");
    expect(setStatus).toHaveBeenCalledWith("Copied");
  });

  it("surfaces a failed execCommand fallback", async () => {
    const hostEl = document.createElement("div");
    const copyButtonEl = createHeaderCopyButton();
    const setStatus = vi.fn();
    const writeText = vi.fn(async () => {
      throw new Error("blocked");
    });
    const execCommand = vi.fn(() => false);
    Object.assign(navigator, {
      clipboard: {
        writeText,
      },
    });
    Object.assign(document, { execCommand });

    renderSummaryMarkdownDisplay({
      activeTabUrl: "https://example.com/watch",
      autoSummarize: false,
      currentSourceTitle: "Video",
      currentSourceUrl: "https://example.com/watch",
      hasSlides: false,
      headerSetStatus: setStatus,
      hostEl,
      copyButtonEl,
      inputMode: "video",
      markdown: "Body",
      md: { render: (value) => `<p>${value}</p>` },
      phase: "done",
      renderInlineSlides: vi.fn(),
      slidesEnabled: false,
      slidesLayout: "gallery",
      tabTitle: "Video",
      tabUrl: "https://example.com/watch",
    });

    copyButtonEl.click();
    await Promise.resolve();

    expect(execCommand).toHaveBeenCalledWith("copy");
    expect(setStatus).toHaveBeenCalledWith("Copy failed");
  });

  it("falls back to the empty state and reports markdown render errors", () => {
    const hostEl = document.createElement("div");
    const setStatus = vi.fn();

    renderSummaryMarkdownDisplay({
      activeTabUrl: "https://example.com/watch",
      autoSummarize: true,
      currentSourceTitle: "Video",
      currentSourceUrl: "https://example.com/watch",
      hasSlides: false,
      headerSetStatus: setStatus,
      hostEl,
      inputMode: "video",
      markdown: "",
      md: { render: (value) => value },
      phase: "connecting",
      renderInlineSlides: vi.fn(),
      slidesEnabled: false,
      slidesLayout: "gallery",
      tabTitle: "Video",
      tabUrl: "https://example.com/watch",
    });
    expect(hostEl.textContent).toContain("Preparing summary");

    renderSummaryMarkdownDisplay({
      activeTabUrl: "https://example.com/watch",
      autoSummarize: false,
      currentSourceTitle: "Video",
      currentSourceUrl: "https://example.com/watch",
      hasSlides: false,
      headerSetStatus: setStatus,
      hostEl,
      inputMode: "video",
      markdown: "body",
      md: {
        render: () => {
          throw new Error("broken markdown");
        },
      },
      phase: "done",
      renderInlineSlides: vi.fn(),
      slidesEnabled: false,
      slidesLayout: "gallery",
      tabTitle: "Video",
      tabUrl: "https://example.com/watch",
    });
    expect(setStatus).toHaveBeenCalledWith(expect.stringContaining("broken markdown"));

    renderSummaryMarkdownDisplay({
      activeTabUrl: "https://example.com/watch",
      autoSummarize: false,
      currentSourceTitle: "Video",
      currentSourceUrl: "https://example.com/watch",
      hasSlides: false,
      headerSetStatus: setStatus,
      hostEl,
      inputMode: "video",
      markdown: "body",
      md: {
        render: () => {
          throw "bad markdown";
        },
      },
      phase: "done",
      renderInlineSlides: vi.fn(),
      slidesEnabled: false,
      slidesLayout: "gallery",
      tabTitle: "Video",
      tabUrl: "https://example.com/watch",
    });
    expect(setStatus).toHaveBeenCalledWith("Error: bad markdown");
  });
});
