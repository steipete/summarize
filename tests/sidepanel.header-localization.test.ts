// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from "vitest";
import { createHeaderController } from "../apps/chrome-extension/src/entrypoints/sidepanel/header-controller";
import { applyExtensionLocale, message } from "../apps/chrome-extension/src/lib/i18n";

const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

afterEach(() => {
  applyExtensionLocale("en")();
  document.body.replaceChildren();
});

describe("localized header progress", () => {
  it("keeps an unknown percentage indeterminate while treating a known zero as real progress", async () => {
    const headerEl = document.createElement("header");
    const titleEl = document.createElement("div");
    const subtitleEl = document.createElement("div");
    const progressFillEl = document.createElement("div");
    headerEl.append(titleEl, subtitleEl, progressFillEl);
    document.body.append(headerEl);
    const header = createHeaderController({
      headerEl,
      titleEl,
      subtitleEl,
      progressFillEl,
      getState: () => ({ phase: "connecting", summaryFromCache: false }),
    });
    header.setBaseTitle("Try again");
    for (const hasPercent of [false, "false"]) {
      header.setStatus(message("progress.browser.download", { hasPercent, percent: 0 }));
      await frame();
      expect(headerEl.classList.contains("isIndeterminate")).toBe(true);
      expect(subtitleEl.textContent).not.toContain("0%");
    }
    header.setStatus(message("progress.browser.download", { hasPercent: true, percent: 0 }));
    await frame();
    expect(headerEl.classList.contains("isIndeterminate")).toBe(false);
    expect(headerEl.style.getPropertyValue("--progress")).toBe("0%");
    header.setStatus(message("progress.browser.download", { hasPercent: true, percent: 0.5 }));
    applyExtensionLocale("tr")();
    await frame();
    expect(headerEl.style.getPropertyValue("--progress")).toBe("50%");
    expect(subtitleEl.textContent).toContain("%50");
    expect(titleEl.textContent).toBe("Try again");
  });
});
