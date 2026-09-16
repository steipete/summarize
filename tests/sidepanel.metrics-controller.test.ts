// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMetricsController } from "../apps/chrome-extension/src/entrypoints/sidepanel/metrics-controller.js";
import { applyExtensionLocale } from "../apps/chrome-extension/src/lib/i18n.js";
import { readMetricParts } from "../apps/chrome-extension/src/lib/metrics.js";
import { buildMetricParts } from "../packages/core/src/localization/presentation.js";

class MockResizeObserver {
  observe() {}
  disconnect() {}
}

describe("sidepanel metrics controller", () => {
  afterEach(() => {
    window.dispatchEvent(new Event("pagehide"));
    applyExtensionLocale("en")();
  });
  beforeEach(() => {
    document.body.innerHTML = "";
    vi.stubGlobal("ResizeObserver", MockResizeObserver);
  });

  it("reformats numeric wire metrics on locale changes without parsing source or model names", () => {
    const metricsEl = document.createElement("div");
    const metricsHomeEl = document.createElement("div");
    const chatMetricsSlotEl = document.createElement("div");
    document.body.append(metricsHomeEl, chatMetricsSlotEl);
    metricsHomeEl.append(metricsEl);
    const controller = createMetricsController({ metricsEl, metricsHomeEl, chatMetricsSlotEl });
    const parts = readMetricParts(
      buildMetricParts({
        elapsedMs: 1500,
        cached: false,
        costUsd: 0.02,
        source: "Try again",
        sourceUrl: "https://example.com",
        model: "openrouter/custom/Copy failed",
        promptTokens: 1200,
        completionTokens: 10,
        totalTokens: 1210,
      }),
    );
    controller.setForMode("summary", "English compatibility text", null, null, parts);
    expect(metricsEl.textContent).toContain("1.5s · $0.02 · Try again");
    applyExtensionLocale("tr")();
    expect(metricsEl.textContent).toContain("1,5sn · $0,02 · Try again");
    expect(metricsEl.textContent).toContain("openrouter/custom/Copy failed");
    expect(metricsEl.querySelector("a")?.href).toBe("https://example.com/");
    expect(metricsEl.textContent).not.toContain("English compatibility text");
    controller.dispose();
  });

  it("renders summary metrics in the home slot", () => {
    const metricsEl = document.createElement("div");
    const metricsHomeEl = document.createElement("div");
    const chatMetricsSlotEl = document.createElement("div");
    document.body.append(metricsHomeEl, chatMetricsSlotEl);
    metricsHomeEl.append(metricsEl);

    const controller = createMetricsController({
      metricsEl: metricsEl as HTMLDivElement,
      metricsHomeEl: metricsHomeEl as HTMLDivElement,
      chatMetricsSlotEl: chatMetricsSlotEl as HTMLDivElement,
    });

    controller.setForMode(
      "summary",
      "12m YouTube · 1.2k words",
      null,
      "https://youtube.com/watch?v=test",
    );
    controller.setActiveMode("summary");

    expect(metricsHomeEl.contains(metricsEl)).toBe(true);
    expect(metricsEl.textContent).toContain("12m");
    expect(metricsEl.textContent).toContain("YouTube");
    expect(metricsEl.classList.contains("hidden")).toBe(false);
  });

  it("moves chat metrics into the chat slot and toggles visibility", () => {
    const metricsEl = document.createElement("div");
    const metricsHomeEl = document.createElement("div");
    const chatMetricsSlotEl = document.createElement("div");
    document.body.append(metricsHomeEl, chatMetricsSlotEl);
    metricsHomeEl.append(metricsEl);

    const controller = createMetricsController({
      metricsEl: metricsEl as HTMLDivElement,
      metricsHomeEl: metricsHomeEl as HTMLDivElement,
      chatMetricsSlotEl: chatMetricsSlotEl as HTMLDivElement,
    });

    controller.setForMode("chat", "Cached · example.com", null, null);
    controller.setActiveMode("chat");

    expect(chatMetricsSlotEl.contains(metricsEl)).toBe(true);
    expect(chatMetricsSlotEl.classList.contains("isVisible")).toBe(true);

    controller.clearForMode("chat");
    controller.setActiveMode("chat");

    expect(metricsEl.textContent).toBe("");
    expect(metricsEl.classList.contains("hidden")).toBe(true);
    expect(chatMetricsSlotEl.classList.contains("isVisible")).toBe(false);
  });
});
