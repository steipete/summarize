import type { SseSlidesData } from "../../lib/runtime-contracts";
import type { SlidesLayout } from "../../lib/settings";
import { resolveSlidesRenderLayout } from "./slides-view-policy";

const MAX_SLIDE_STRIP = 12;

type SlidesRendererState = {
  slidesEnabled: boolean;
  inputMode: "page" | "video";
  preferredLayout: SlidesLayout;
  slidesExpanded: boolean;
  slides: SseSlidesData | null;
  descriptions: Map<number, string>;
  titles: Map<number, string>;
};

export function createSlidesRenderer({
  hostEl,
  markdownHostEl,
  getState,
  ensureDescriptions,
  onSeek,
  setExpanded,
  updateThumb,
  updateMeta,
}: {
  hostEl: HTMLElement;
  markdownHostEl: HTMLElement;
  getState: () => SlidesRendererState;
  ensureDescriptions: () => void;
  onSeek: (seconds: number | null | undefined) => void;
  setExpanded: (next: boolean) => void;
  updateThumb: (
    img: HTMLImageElement,
    thumb: HTMLElement,
    imageUrl: string | null | undefined,
  ) => void;
  updateMeta: (
    el: HTMLElement,
    index: number,
    timestamp: number | null | undefined,
    title?: string | null,
    total?: number | null,
  ) => void;
}) {
  let stripRenderQueued = 0;
  let galleryRenderQueued = 0;

  const shouldRenderSlides = () => {
    const state = getState();
    return state.slidesEnabled && state.inputMode === "video";
  };

  const resolveLayout = () => {
    const state = getState();
    return resolveSlidesRenderLayout({
      preferredLayout: state.preferredLayout,
      slidesEnabled: state.slidesEnabled,
      inputMode: state.inputMode,
    });
  };

  const bindSeek = (el: HTMLElement, timestamp: number | null | undefined) => {
    el.onclick = () => onSeek(timestamp);
  };

  const clearSlideStrip = (container: HTMLElement) => {
    container.querySelector(".slideStrip")?.remove();
  };

  const clearSlideGallery = (container: HTMLElement) => {
    container.querySelector(".slideGallery")?.remove();
  };

  const stripSlidePlaceholders = (container: HTMLElement) => {
    for (const placeholder of Array.from(container.querySelectorAll("span.slideInline"))) {
      placeholder.remove();
    }
  };

  const renderSlideStrip = (container: HTMLElement) => {
    if (resolveLayout() !== "strip") {
      clearSlideStrip(container);
      return;
    }
    if (!shouldRenderSlides()) {
      clearSlideStrip(container);
      return;
    }
    const state = getState();
    if (!state.slides) return;
    if (state.slides.slides.length > 0 && state.descriptions.size === 0) {
      ensureDescriptions();
    }
    const allSlides = state.slides.slides;
    const slides = state.slidesExpanded ? allSlides : allSlides.slice(0, MAX_SLIDE_STRIP);
    if (allSlides.length === 0 || slides.length === 0) {
      clearSlideStrip(container);
      return;
    }

    const expectedMode = state.slidesExpanded ? "expanded" : "collapsed";
    const sourceId = state.slides.sourceId;
    let root = container.querySelector<HTMLDivElement>(".slideStrip");
    if (!root || root.dataset.sourceId !== sourceId || root.dataset.mode !== expectedMode) {
      clearSlideStrip(container);
      root = document.createElement("div");
      root.className = "slideStrip";
      root.dataset.sourceId = sourceId;
      root.dataset.mode = expectedMode;

      const header = document.createElement("div");
      header.className = "slideStrip__header";

      const title = document.createElement("div");
      title.className = "slideStrip__title";
      header.appendChild(title);

      const toggle = document.createElement("button");
      toggle.type = "button";
      toggle.className = "slideStrip__toggle";
      toggle.addEventListener("click", () => {
        setExpanded(!getState().slidesExpanded);
        renderSlideStrip(container);
      });
      header.appendChild(toggle);
      root.appendChild(header);

      const grid = document.createElement("div");
      grid.className = "slideStrip__grid";
      root.appendChild(grid);
      container.prepend(root);
    }

    const title = root.querySelector<HTMLDivElement>(".slideStrip__title");
    const toggle = root.querySelector<HTMLButtonElement>(".slideStrip__toggle");
    const grid = root.querySelector<HTMLDivElement>(".slideStrip__grid");
    if (!title || !toggle || !grid) return;

    const total = allSlides.length;
    title.textContent =
      !state.slidesExpanded && total > slides.length
        ? `Slides (${total}) · showing ${slides.length}`
        : `Slides (${total})`;
    toggle.textContent = state.slidesExpanded ? "Collapse" : "Expand";
    toggle.setAttribute("aria-pressed", state.slidesExpanded ? "true" : "false");
    grid.classList.toggle("isExpanded", state.slidesExpanded);

    const existingButtons = new Map<number, HTMLButtonElement>();
    for (const button of Array.from(
      grid.querySelectorAll<HTMLButtonElement>(".slideStrip__item"),
    )) {
      const idx = Number(button.dataset.slideIndex);
      if (Number.isFinite(idx)) existingButtons.set(idx, button);
    }

    const wanted = new Set<number>(slides.map((slide) => slide.index));
    for (const [idx, button] of existingButtons) {
      if (!wanted.has(idx)) button.remove();
    }

    for (const slide of slides) {
      let button = existingButtons.get(slide.index);
      if (!button) {
        button = document.createElement("button");
        button.type = "button";
        button.className = "slideStrip__item";
        button.dataset.slideIndex = String(slide.index);

        const thumb = document.createElement("div");
        thumb.className = "slideStrip__thumb";
        const img = document.createElement("img");
        img.alt = `Slide ${slide.index}`;
        img.className = "slideStrip__thumbImage";
        thumb.appendChild(img);

        const meta = document.createElement("div");
        meta.className = "slideStrip__meta";
        meta.dataset.localeIgnore = "true";

        button.append(thumb, meta);
        grid.appendChild(button);
      }

      const thumb = button.querySelector<HTMLDivElement>(".slideStrip__thumb");
      const img = button.querySelector<HTMLImageElement>("img.slideStrip__thumbImage");
      const meta = button.querySelector<HTMLDivElement>(".slideStrip__meta");
      if (!thumb || !img || !meta) continue;

      updateThumb(img, thumb, slide.imageUrl);
      updateMeta(
        meta,
        slide.index,
        slide.timestamp,
        state.titles.get(slide.index) ?? null,
        slides.length,
      );

      const existingText = button.querySelector<HTMLDivElement>(".slideStrip__text");
      if (state.slidesExpanded) {
        const textEl =
          existingText ??
          (() => {
            const description = document.createElement("div");
            description.className = "slideStrip__text";
            description.dataset.localeIgnore = "true";
            button.appendChild(description);
            return description;
          })();
        textEl.textContent = state.descriptions.get(slide.index) ?? "";
      } else {
        existingText?.remove();
      }

      bindSeek(button, slide.timestamp);
      grid.appendChild(button);
    }
  };

  const renderSlideGallery = (container: HTMLElement) => {
    if (resolveLayout() !== "gallery") {
      clearSlideGallery(container);
      return;
    }
    if (!shouldRenderSlides()) {
      clearSlideGallery(container);
      return;
    }
    const state = getState();
    if (!state.slides) {
      clearSlideGallery(container);
      return;
    }
    if (state.slides.slides.length > 0 && state.descriptions.size === 0) {
      ensureDescriptions();
    }
    const slides = state.slides.slides;
    if (slides.length === 0) {
      clearSlideGallery(container);
      return;
    }

    let root = container.querySelector<HTMLDivElement>(".slideGallery");
    if (!root || root.dataset.sourceId !== state.slides.sourceId) {
      clearSlideGallery(container);
      root = document.createElement("div");
      root.className = "slideGallery";
      root.dataset.sourceId = state.slides.sourceId;

      const list = document.createElement("div");
      list.className = "slideGallery__list";
      root.appendChild(list);

      container.prepend(root);
    }

    const list = root.querySelector<HTMLDivElement>(".slideGallery__list");
    if (!list) return;

    const existingItems = new Map<number, HTMLElement>();
    for (const item of Array.from(list.querySelectorAll<HTMLElement>(".slideGallery__item"))) {
      const idx = Number(item.dataset.slideIndex);
      if (Number.isFinite(idx)) existingItems.set(idx, item);
    }

    const wanted = new Set<number>(slides.map((slide) => slide.index));
    for (const [idx, item] of existingItems) {
      if (!wanted.has(idx)) item.remove();
    }

    for (const slide of slides) {
      let item = existingItems.get(slide.index);
      if (!item) {
        item = document.createElement("button");
        item.type = "button";
        item.className = "slideGallery__item";
        item.dataset.slideIndex = String(slide.index);

        const media = document.createElement("div");
        media.className = "slideGallery__media";

        const thumb = document.createElement("div");
        thumb.className = "slideInline__thumb slideGallery__thumb isPlaceholder";
        const img = document.createElement("img");
        img.alt = `Slide ${slide.index}`;
        img.className = "slideInline__thumbImage";
        thumb.appendChild(img);
        media.appendChild(thumb);

        const body = document.createElement("div");
        body.className = "slideGallery__body";
        const meta = document.createElement("div");
        meta.className = "slideGallery__meta";
        meta.dataset.localeIgnore = "true";
        const text = document.createElement("div");
        text.className = "slideGallery__text";
        text.dataset.localeIgnore = "true";
        body.append(meta, text);

        item.append(media, body);
        list.appendChild(item);
      }

      const thumb = item.querySelector<HTMLDivElement>(".slideGallery__thumb");
      const img = item.querySelector<HTMLImageElement>("img.slideInline__thumbImage");
      const meta = item.querySelector<HTMLDivElement>(".slideGallery__meta");
      const text = item.querySelector<HTMLDivElement>(".slideGallery__text");
      if (!thumb || !img || !meta || !text) continue;

      updateThumb(img, thumb, slide.imageUrl);
      updateMeta(
        meta,
        slide.index,
        slide.timestamp,
        state.titles.get(slide.index) ?? null,
        slides.length,
      );
      text.textContent = state.descriptions.get(slide.index) ?? "";
      bindSeek(item, slide.timestamp);
      list.appendChild(item);
    }
  };

  const renderInline = (container: HTMLElement, opts?: { fallback?: boolean }) => {
    if (container === markdownHostEl) {
      stripSlidePlaceholders(container);
      if (opts?.fallback) queueRender();
      return;
    }
    const state = getState();
    if (!state.slides) {
      if (opts?.fallback) clearSlideStrip(hostEl);
      return;
    }
    const slidesByIndex = new Map(state.slides.slides.map((slide) => [slide.index, slide]));
    const slideTotal = state.slides.slides.length || slidesByIndex.size;
    let replacedCount = 0;
    for (const placeholder of Array.from(container.querySelectorAll("span.slideInline"))) {
      const index = Number(placeholder.getAttribute("data-slide-index"));
      const slide = slidesByIndex.get(index);
      if (!slide) continue;
      const wrapper = document.createElement("div");
      wrapper.className = "slideInline";
      wrapper.dataset.slideIndex = String(index);
      const button = document.createElement("button");
      button.type = "button";
      const thumb = document.createElement("div");
      thumb.className = "slideInline__thumb isPlaceholder";
      const img = document.createElement("img");
      img.alt = `Slide ${index}`;
      img.className = "slideInline__thumbImage";
      updateThumb(img, thumb, slide.imageUrl);
      const caption = document.createElement("div");
      caption.className = "slideCaption";
      caption.dataset.localeIgnore = "true";
      updateMeta(caption, index, slide.timestamp, state.titles.get(index) ?? null, slideTotal);
      thumb.appendChild(img);
      button.append(thumb, caption);
      bindSeek(button, slide.timestamp);
      wrapper.appendChild(button);
      placeholder.replaceWith(wrapper);
      replacedCount += 1;
    }
    if (opts?.fallback && replacedCount === 0) {
      queueRender();
    }
  };

  const queueSlideStripRender = () => {
    if (resolveLayout() !== "strip") {
      clearSlideStrip(hostEl);
      return;
    }
    if (stripRenderQueued) return;
    stripRenderQueued = window.setTimeout(() => {
      stripRenderQueued = 0;
      renderSlideStrip(hostEl);
    }, 120);
  };

  const queueSlideGalleryRender = () => {
    if (resolveLayout() !== "gallery") {
      clearSlideGallery(hostEl);
      return;
    }
    if (galleryRenderQueued) return;
    galleryRenderQueued = window.setTimeout(() => {
      galleryRenderQueued = 0;
      renderSlideGallery(hostEl);
    }, 120);
  };

  const queueRender = () => {
    if (resolveLayout() === "gallery") {
      queueSlideGalleryRender();
    } else {
      queueSlideStripRender();
    }
  };

  const applyLayout = () => {
    if (resolveLayout() === "gallery") {
      clearSlideStrip(hostEl);
      queueSlideGalleryRender();
      return;
    }
    clearSlideGallery(hostEl);
    queueSlideStripRender();
  };

  const clear = () => {
    clearSlideStrip(hostEl);
    clearSlideGallery(hostEl);
  };

  const forceRender = () => {
    if (resolveLayout() === "gallery") {
      renderSlideGallery(hostEl);
    } else {
      renderSlideStrip(hostEl);
    }
    return hostEl.children.length;
  };

  return {
    applyLayout,
    clear,
    queueRender,
    renderInline,
    forceRender,
  };
}
