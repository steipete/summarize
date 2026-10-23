// @vitest-environment happy-dom
import { expect, it, vi } from "vitest";
import { createDrawerControls } from "../apps/chrome-extension/src/entrypoints/sidepanel/drawer-controls";
import { createSlidesRenderer } from "../apps/chrome-extension/src/entrypoints/sidepanel/slides-renderer";

vi.mock("../apps/chrome-extension/src/entrypoints/sidepanel/slides-view-policy", () => ({
  resolveSlidesRenderLayout: () => "strip",
}));

it("limits the collapsed slide strip", () => {
  for (const slidesExpanded of [false, true]) {
    const hostEl = document.createElement("div");
    const slides = Array.from({ length: 15 }, (_, index) => ({ index }));
    createSlidesRenderer({
      hostEl,
      getState: () => ({
        slidesEnabled: true,
        inputMode: "video",
        slidesExpanded,
        slides: { sourceId: "s", slides },
        descriptions: new Map([[0, ""]]),
        titles: new Map(),
      }),
      updateThumb: vi.fn(),
      updateMeta: vi.fn(),
    } as never).forceRender();
    expect(hostEl.querySelectorAll(".slideStrip__item")).toHaveLength(slidesExpanded ? 15 : 12);
  }
});

it("styles advanced settings before opening and measuring them", () => {
  const advancedSettingsEl = document.createElement("details");
  const advancedSettingsBodyEl = document.createElement("div");
  const seen: string[] = [];
  Object.defineProperty(advancedSettingsBodyEl, "scrollHeight", {
    get: () => seen.push(`${advancedSettingsEl.open}:${advancedSettingsBodyEl.style.height}`),
  });
  advancedSettingsBodyEl.animate = vi.fn(() => ({}) as Animation);
  const controls = createDrawerControls({ advancedSettingsEl, advancedSettingsBodyEl } as never);
  controls.toggleAdvancedSettings(true);
  expect(seen).toEqual(["true:0px"]);
});
