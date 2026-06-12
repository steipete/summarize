import type { SlideTimelineEntry } from "@steipete/summarize-core/slides";
import type { SlideImage, SlideExtractionResult } from "../../../slides/index.js";

export type SlideState = SlideTimelineEntry & { imagePath: string | null };

export function createSlideOutputState(initialSlides: SlideExtractionResult | null | undefined) {
  const slidesByIndex = new Map<number, SlideState>();
  const pending = new Map<number, Array<(value: SlideState | null) => void>>();
  let order: number[] = [];
  let slidesDir = initialSlides?.slidesDir ?? "";
  let sourceUrl = initialSlides?.sourceUrl ?? "";
  let done = false;

  const updateSlideEntry = (slide: SlideImage) => {
    const existing = slidesByIndex.get(slide.index);
    const next: SlideState = {
      index: slide.index,
      timestamp:
        Number.isFinite(slide.timestamp) && slide.timestamp >= 0
          ? slide.timestamp
          : (existing?.timestamp ?? 0),
      imagePath: slide.imagePath ? slide.imagePath : (existing?.imagePath ?? null),
    };
    slidesByIndex.set(slide.index, next);
    if (slide.imagePath) {
      const waiters = pending.get(slide.index);
      if (waiters && waiters.length > 0) {
        pending.delete(slide.index);
        for (const resolve of waiters) {
          resolve(next);
        }
      }
    }
  };

  const setMeta = (meta: { slidesDir?: string | null; sourceUrl?: string | null }) => {
    if (meta.slidesDir) slidesDir = meta.slidesDir;
    if (meta.sourceUrl) sourceUrl = meta.sourceUrl;
  };

  const updateFromSlides = (slides: SlideExtractionResult) => {
    slidesDir = slides.slidesDir;
    sourceUrl = slides.sourceUrl;
    const ordered = slides.slides
      .filter((slide) => Number.isFinite(slide.timestamp))
      .map((slide) => ({ index: slide.index, timestamp: slide.timestamp }))
      .sort((a, b) => a.timestamp - b.timestamp);
    order = ordered.map((slide) => slide.index);
    for (const slide of slides.slides) {
      updateSlideEntry(slide);
    }
  };

  if (initialSlides) updateFromSlides(initialSlides);

  const markDone = () => {
    if (done) return;
    done = true;
    for (const [index, waiters] of pending.entries()) {
      const entry = slidesByIndex.get(index) ?? null;
      for (const resolve of waiters) {
        resolve(entry);
      }
    }
    pending.clear();
  };

  const waitForSlide = (index: number): Promise<SlideState | null> => {
    const existing = slidesByIndex.get(index);
    if (existing?.imagePath) return Promise.resolve(existing);
    if (done) return Promise.resolve(existing ?? null);
    return new Promise((resolve) => {
      const list = pending.get(index) ?? [];
      list.push(resolve);
      pending.set(index, list);
    });
  };

  return {
    setMeta,
    updateFromSlides,
    updateSlideEntry,
    waitForSlide,
    markDone,
    getSlides: () => order.map((index) => slidesByIndex.get(index)).filter(Boolean) as SlideState[],
    getSlide: (index: number) => slidesByIndex.get(index) ?? null,
    getOrder: () => order.slice(),
    getSlidesDir: () => slidesDir,
    getSourceUrl: () => sourceUrl,
    isDone: () => done,
  };
}
