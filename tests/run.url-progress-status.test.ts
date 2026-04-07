import { describe, expect, it, vi } from "vitest";
import { createUrlProgressStatus } from "../src/run/flows/url/progress-status.js";

describe("url progress status", () => {
  it("keeps slide progress visible while summary updates happen", () => {
    const setText = vi.fn();
    const refresh = vi.fn();
    const oscProgress = {
      setIndeterminate: vi.fn(),
      setPercent: vi.fn(),
      clear: vi.fn(),
    };
    const status = createUrlProgressStatus({
      enabled: true,
      spinner: { setText, refresh },
      oscProgress,
    });

    status.setSummary("Summarizing…", "Summarizing");
    status.setSlides("Slides: detecting scenes 35%", 35);
    status.setSummary("Summarizing (model: openai/gpt-5.4)…", "Summarizing");

    expect(setText.mock.calls.map((call) => call[0])).toEqual([
      "Summarizing…",
      "Slides: detecting scenes 35%",
    ]);
    expect(oscProgress.setPercent).toHaveBeenLastCalledWith("Slides", 35);
    expect(refresh).toHaveBeenCalled();
  });

  it("restores the latest summary line after slides finish", () => {
    const setText = vi.fn();
    const oscProgress = {
      setIndeterminate: vi.fn(),
      setPercent: vi.fn(),
      clear: vi.fn(),
    };
    const status = createUrlProgressStatus({
      enabled: true,
      spinner: { setText },
      oscProgress,
    });

    status.setSummary("Summarizing…", "Summarizing");
    status.setSlides("Slides: detecting scenes 35%", 35);
    status.setSummary("Summarizing (model: openai/gpt-5.4)…", "Summarizing");
    status.clearSlides();

    expect(setText.mock.calls.at(-1)?.[0]).toBe("Summarizing (model: openai/gpt-5.4)…");
    expect(oscProgress.setIndeterminate).toHaveBeenLastCalledWith("Summarizing");
  });

  it("throttles rapid slide text repaint while still updating OSC progress", () => {
    const setText = vi.fn();
    const oscProgress = {
      setIndeterminate: vi.fn(),
      setPercent: vi.fn(),
      clear: vi.fn(),
    };
    let nowMs = 0;
    const status = createUrlProgressStatus({
      enabled: true,
      spinner: { setText },
      oscProgress,
      now: () => nowMs,
    });

    status.setSlides("Slides: downloading 10%", 10);
    nowMs = 50;
    status.setSlides("Slides: downloading 11%", 11);
    nowMs = 150;
    status.setSlides("Slides: downloading 12%", 12);

    expect(setText.mock.calls.map((call) => call[0])).toEqual([
      "Slides: downloading 10%",
      "Slides: downloading 12%",
    ]);
    expect(oscProgress.setPercent).toHaveBeenNthCalledWith(1, "Slides", 10);
    expect(oscProgress.setPercent).toHaveBeenNthCalledWith(2, "Slides", 11);
    expect(oscProgress.setPercent).toHaveBeenNthCalledWith(3, "Slides", 12);
  });
});
