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

it("reconciles slide order, removed slides, seek targets, and source changes", () => {
  const hostEl = document.createElement("div");
  const onSeek = vi.fn();
  const state = {
    slidesEnabled: true,
    inputMode: "video",
    slidesExpanded: false,
    slides: {
      sourceId: "first",
      slides: [0, 1, 2].map((index) => ({ index, timestamp: index * 10 })),
    },
    descriptions: new Map([[0, "description"]]),
    titles: new Map(),
  };
  const renderer = createSlidesRenderer({
    hostEl,
    getState: () => state,
    updateThumb: vi.fn(),
    updateMeta: vi.fn(),
    onSeek,
  } as never);
  renderer.forceRender();
  const root = hostEl.querySelector(".slideStrip");
  const retained = hostEl.querySelector('[data-slide-index="2"]');
  state.slides.slides = [
    { index: 2, timestamp: 25 },
    { index: 0, timestamp: 0 },
  ];
  renderer.forceRender();
  expect(hostEl.querySelector(".slideStrip")).toBe(root);
  const items = Array.from(hostEl.querySelectorAll<HTMLButtonElement>(".slideStrip__item"));
  expect(items.map((item) => item.dataset.slideIndex)).toEqual(["2", "0"]);
  expect(items[0]).toBe(retained);
  items[0].click();
  expect(onSeek).toHaveBeenCalledExactlyOnceWith(25);

  state.slides.sourceId = "second";
  renderer.forceRender();
  expect(hostEl.querySelector(".slideStrip")).not.toBe(root);
  expect(hostEl.querySelector('[data-slide-index="2"]')).not.toBe(retained);
});
