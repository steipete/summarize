import { beforeEach, describe, expect, it, vi } from "vitest";

const osc = {
  clear: vi.fn(),
  setIndeterminate: vi.fn(),
  setPercent: vi.fn(),
};

const spinner = {
  pause: vi.fn(),
  resume: vi.fn(),
  setText: vi.fn(),
  stopAndClear: vi.fn(),
};

const websiteProgress = {
  stop: vi.fn(),
};

vi.mock("../src/tty/osc-progress.js", () => ({
  createOscProgressController: vi.fn(() => osc),
}));

vi.mock("../src/tty/spinner.js", () => ({
  startSpinner: vi.fn(() => spinner),
}));

vi.mock("../src/tty/website-progress.js", () => ({
  createWebsiteProgress: vi.fn(() => websiteProgress),
}));

import {
  createUrlFlowProgress,
  writeSlidesBackgroundFailureWarning,
} from "../src/run/flows/url/flow-progress.js";

function createTheme() {
  return {
    dim: (value: string) => `<d>${value}</d>`,
    label: (value: string) => `<l>${value}</l>`,
    palette: { spinner: "cyan" },
    warning: (value: string) => `<w>${value}</w>`,
  };
}

function createContext(overrides: Record<string, unknown> = {}) {
  return {
    flags: {
      extractMode: false,
      json: false,
      progressEnabled: true,
    },
    hooks: {
      clearProgressForStdout: vi.fn(),
      restoreProgressAfterStdout: vi.fn(),
    },
    io: {
      env: {},
      stderr: { write: vi.fn() },
    },
    ...overrides,
  };
}

describe("url flow progress", () => {
  it("translates keyed statuses while preserving opaque diagnostics", () => {
    const ctx = createContext({
      io: { env: { SUMMARIZE_LOCALE: "tr" }, stderr: { write: vi.fn() } },
      flags: { progressEnabled: false },
    });
    const progress = createUrlFlowProgress({ ctx: ctx as never, theme: createTheme() as never });
    expect(progress.renderStatus("x.fetching.via.syndication.api")).toBe(
      "<l>X</l><d>: Syndication API üzerinden alınıyor…</d>",
    );
    expect(progress.renderStatusFromText("Error: Copy failed: /path/cache.json")).toContain(
      "Copy failed: /path/cache.json",
    );
    progress.stopProgress();
  });
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it("writes a dependency warning with install help", () => {
    const ctx = createContext();

    writeSlidesBackgroundFailureWarning({
      ctx: ctx as never,
      theme: createTheme() as never,
      message: "Missing ffmpeg in PATH",
    });

    expect(ctx.hooks.clearProgressForStdout).toHaveBeenCalled();
    expect(ctx.io.stderr.write).toHaveBeenNthCalledWith(
      1,
      "<w>Warning:</w> --slides could not extract slide images: Missing ffmpeg in PATH\n",
    );
    expect(ctx.io.stderr.write).toHaveBeenNthCalledWith(
      2,
      "<d>Install ffmpeg + yt-dlp for --slides, and tesseract for --slides-ocr.</d>\n",
    );
    expect(ctx.hooks.restoreProgressAfterStdout).toHaveBeenCalled();
  });

  it("skips warning output for json and extract mode", () => {
    const jsonCtx = createContext({
      flags: { extractMode: false, json: true, progressEnabled: true },
    });
    writeSlidesBackgroundFailureWarning({
      ctx: jsonCtx as never,
      theme: createTheme() as never,
      message: "Missing ffmpeg",
    });
    expect(jsonCtx.io.stderr.write).not.toHaveBeenCalled();

    const extractCtx = createContext({
      flags: { extractMode: true, json: false, progressEnabled: true },
    });
    writeSlidesBackgroundFailureWarning({
      ctx: extractCtx as never,
      theme: createTheme() as never,
      message: "Missing ffmpeg",
    });
    expect(extractCtx.io.stderr.write).not.toHaveBeenCalled();
  });

  it("wires slide progress, pause/resume, and shutdown cleanup", () => {
    const once = vi.spyOn(process, "once").mockReturnValue(process);
    const removeListener = vi.spyOn(process, "removeListener").mockReturnValue(process);
    const ctx = createContext();

    const progress = createUrlFlowProgress({
      ctx: ctx as never,
      theme: createTheme() as never,
    });

    expect(once).toHaveBeenCalledWith("SIGINT", expect.any(Function));
    expect(once).toHaveBeenCalledWith("SIGTERM", expect.any(Function));
    expect(osc.setIndeterminate).toHaveBeenCalledWith("Fetching website");

    expect(ctx.hooks.onSlidesProgress).toBeUndefined();
    progress.hooks.onSlidesProgress?.("Slides: detecting scenes 35%");
    expect(spinner.setText).toHaveBeenCalledWith("<l>Slides: detecting scenes 35%</l>");
    expect(osc.setPercent).toHaveBeenCalledWith("Slides", 35);
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 1000);
    progress.hooks.onSlidesProgress?.("Opaque callback text", {
      key: "progress.slides",
      values: { phase: "detect", detail: "", hasDetail: false, percent: 0.42 },
    });
    expect(osc.setPercent).toHaveBeenCalledWith("Slides", 42);
    expect(spinner.setText).toHaveBeenCalledWith("<l>Slides: detecting scenes 42%</l>");

    progress.hooks.onSlidesProgress?.("Slides: extracting");
    expect(osc.setIndeterminate).toHaveBeenCalledWith("Slides");

    const resume = progress.pauseProgress();
    expect(spinner.pause).toHaveBeenCalled();
    resume();
    expect(spinner.resume).toHaveBeenCalled();

    progress.stopProgress();
    expect(websiteProgress.stop).toHaveBeenCalled();
    expect(spinner.stopAndClear).toHaveBeenCalled();
    expect(osc.clear).toHaveBeenCalled();
    expect(removeListener).toHaveBeenCalledWith("SIGINT", progress.handleSigint);
    expect(removeListener).toHaveBeenCalledWith("SIGTERM", progress.handleSigterm);
  });

  it("preserves an existing slide-progress hook and stays inert without tty progress", () => {
    const existing = vi.fn();
    const ctx = createContext({
      flags: { extractMode: false, json: false, progressEnabled: false },
      hooks: {
        clearProgressForStdout: vi.fn(),
        onSlidesProgress: existing,
      },
    });

    const progress = createUrlFlowProgress({
      ctx: ctx as never,
      theme: createTheme() as never,
    });

    expect(ctx.hooks.onSlidesProgress).toBe(existing);
    progress.progressStatus.setSummary("Summary ready", "Summarizing");
    expect(spinner.setText).not.toHaveBeenCalled();
    progress.stopProgress();
    expect(websiteProgress.stop).not.toHaveBeenCalled();
  });
});
