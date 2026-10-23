import {
  setText as setUiText,
  message as uiMessage,
  setLocalizedAttribute as setUiAttribute,
} from "../../lib/i18n";
import type { SseSlidesData } from "../../lib/runtime-contracts";
import type { SlidesLayout } from "../../lib/settings";
import { resolveSlidesRenderLayout } from "./slides-view-policy";

const MAX_SLIDE_STRIP = 12;

type SlideItem = SseSlidesData["slides"][number];

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className: string) => {
  const element = document.createElement(tag);
  element.className = className;
  return element;
};

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

  const clearSlideRoot = (container: HTMLElement, className: string) => {
    container.querySelector(`.${className}`)?.remove();
  };

  const stripSlidePlaceholders = (container: HTMLElement) => {
    for (const placeholder of Array.from(container.querySelectorAll("span.slideInline"))) {
      placeholder.remove();
    }
  };

  const ensureSlideRoot = (
    container: HTMLElement,
    className: string,
    sourceId: string,
    mode: string | null,
    buildBody: (root: HTMLDivElement) => void,
  ): HTMLDivElement => {
    let root = container.querySelector<HTMLDivElement>(`.${className}`);
    if (
      !root ||
      root.dataset.sourceId !== sourceId ||
      (mode !== null && root.dataset.mode !== mode)
    ) {
      root?.remove();
      root = document.createElement("div");
      root.className = className;
      root.dataset.sourceId = sourceId;
      if (mode !== null) root.dataset.mode = mode;
      buildBody(root);
      container.prepend(root);
    }
    return root;
  };

  const reconcileSlideItems = (
    host: HTMLElement,
    itemSelector: string,
    slides: SlideItem[],
    createItem: (slide: SlideItem) => HTMLButtonElement,
    updateItem: (item: HTMLButtonElement, slide: SlideItem) => boolean,
  ) => {
    const existingItems = new Map<number, HTMLButtonElement>();
    for (const item of Array.from(host.querySelectorAll<HTMLButtonElement>(itemSelector))) {
      const index = Number(item.dataset.slideIndex);
      if (Number.isFinite(index)) existingItems.set(index, item);
    }

    const wanted = new Set<number>(slides.map((slide) => slide.index));
    for (const [index, item] of existingItems) {
      if (!wanted.has(index)) item.remove();
    }

    for (const slide of slides) {
      let item = existingItems.get(slide.index);
      if (!item) {
        item = createItem(slide);
        host.appendChild(item);
      }
      if (updateItem(item, slide)) host.appendChild(item);
    }
  };

  const resolveRenderContext = (
    container: HTMLElement,
    layout: SlidesLayout,
    rootClassName: string,
    clearOnMissingSlides: boolean,
  ) => {
    if (resolveLayout() !== layout || !shouldRenderSlides()) {
      clearSlideRoot(container, rootClassName);
      return null;
    }
    const state = getState();
    const slidesData = state.slides;
    if (!slidesData) {
      if (clearOnMissingSlides) clearSlideRoot(container, rootClassName);
      return null;
    }
    if (slidesData.slides.length > 0 && state.descriptions.size === 0) {
      ensureDescriptions();
    }
    return { state, slidesData, allSlides: slidesData.slides };
  };

  const renderSlideStrip = (container: HTMLElement) => {
    const context = resolveRenderContext(container, "strip", "slideStrip", false);
    if (!context) return;
    const { state, slidesData, allSlides } = context;
    const slides = state.slidesExpanded ? allSlides : allSlides.slice(0, MAX_SLIDE_STRIP);
    if (slides.length === 0) {
      clearSlideRoot(container, "slideStrip");
      return;
    }

    const expectedMode = state.slidesExpanded ? "expanded" : "collapsed";
    const root = ensureSlideRoot(
      container,
      "slideStrip",
      slidesData.sourceId,
      expectedMode,
      (element) => {
        const header = el("div", "slideStrip__header");
        const title = el("div", "slideStrip__title");
        header.appendChild(title);

        const toggle = el("button", "slideStrip__toggle");
        toggle.type = "button";
        toggle.addEventListener("click", () => {
          setExpanded(!getState().slidesExpanded);
          renderSlideStrip(container);
        });
        header.appendChild(toggle);
        element.appendChild(header);

        element.appendChild(el("div", "slideStrip__grid"));
      },
    );

    const title = root.querySelector<HTMLDivElement>(".slideStrip__title");
    const toggle = root.querySelector<HTMLButtonElement>(".slideStrip__toggle");
    const grid = root.querySelector<HTMLDivElement>(".slideStrip__grid");
    if (!title || !toggle || !grid) return;

    const total = allSlides.length;
    setUiText(
      title,
      uiMessage("slides.countTitle", {
        total,
        shown: slides.length,
        partial: !state.slidesExpanded && total > slides.length,
      }),
    );
    setUiText(toggle, state.slidesExpanded ? uiMessage("collapse") : uiMessage("expand"));
    toggle.setAttribute("aria-pressed", state.slidesExpanded ? "true" : "false");
    grid.classList.toggle("isExpanded", state.slidesExpanded);

    reconcileSlideItems(
      grid,
      ".slideStrip__item",
      slides,
      (slide) => {
        const button = el("button", "slideStrip__item");
        button.type = "button";
        button.dataset.slideIndex = String(slide.index);

        const thumb = el("div", "slideStrip__thumb");
        const img = el("img", "slideStrip__thumbImage");
        setUiAttribute(img, "alt", uiMessage("slides.imageAlt", { index: slide.index }));
        thumb.appendChild(img);

        const meta = el("div", "slideStrip__meta");
        meta.dataset.localeIgnore = "true";

        button.append(thumb, meta);
        return button;
      },
      (button, slide) => {
        const thumb = button.querySelector<HTMLDivElement>(".slideStrip__thumb");
        const img = button.querySelector<HTMLImageElement>("img.slideStrip__thumbImage");
        const meta = button.querySelector<HTMLDivElement>(".slideStrip__meta");
        if (!thumb || !img || !meta) return false;

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
              const description = el("div", "slideStrip__text");
              description.dataset.localeIgnore = "true";
              button.appendChild(description);
              return description;
            })();
          setUiText(textEl, state.descriptions.get(slide.index) ?? "");
        } else {
          existingText?.remove();
        }

        bindSeek(button, slide.timestamp);
        return true;
      },
    );
  };

  const renderSlideGallery = (container: HTMLElement) => {
    const context = resolveRenderContext(container, "gallery", "slideGallery", true);
    if (!context) return;
    const { state, slidesData, allSlides: slides } = context;
    if (slides.length === 0) {
      clearSlideRoot(container, "slideGallery");
      return;
    }

    const root = ensureSlideRoot(
      container,
      "slideGallery",
      slidesData.sourceId,
      null,
      (element) => {
        element.appendChild(el("div", "slideGallery__list"));
      },
    );

    const list = root.querySelector<HTMLDivElement>(".slideGallery__list");
    if (!list) return;

    reconcileSlideItems(
      list,
      ".slideGallery__item",
      slides,
      (slide) => {
        const item = el("button", "slideGallery__item");
        item.type = "button";
        item.dataset.slideIndex = String(slide.index);

        const media = el("div", "slideGallery__media");
        const thumb = document.createElement("div");
        thumb.className = "slideInline__thumb slideGallery__thumb isPlaceholder";
        const img = el("img", "slideInline__thumbImage");
        setUiAttribute(img, "alt", uiMessage("slides.imageAlt", { index: slide.index }));
        thumb.appendChild(img);
        media.appendChild(thumb);

        const body = el("div", "slideGallery__body");
        const meta = el("div", "slideGallery__meta");
        meta.dataset.localeIgnore = "true";
        const text = el("div", "slideGallery__text");
        text.dataset.localeIgnore = "true";
        body.append(meta, text);

        item.append(media, body);
        return item;
      },
      (item, slide) => {
        const thumb = item.querySelector<HTMLDivElement>(".slideGallery__thumb");
        const img = item.querySelector<HTMLImageElement>("img.slideInline__thumbImage");
        const meta = item.querySelector<HTMLDivElement>(".slideGallery__meta");
        const text = item.querySelector<HTMLDivElement>(".slideGallery__text");
        if (!thumb || !img || !meta || !text) return false;

        updateThumb(img, thumb, slide.imageUrl);
        updateMeta(
          meta,
          slide.index,
          slide.timestamp,
          state.titles.get(slide.index) ?? null,
          slides.length,
        );
        setUiText(text, state.descriptions.get(slide.index) ?? "");
        bindSeek(item, slide.timestamp);
        return true;
      },
    );
  };

  const renderInline = (container: HTMLElement, opts?: { fallback?: boolean }) => {
    if (container === markdownHostEl) {
      stripSlidePlaceholders(container);
      if (opts?.fallback) queueRender();
      return;
    }
    const state = getState();
    if (!state.slides) {
      if (opts?.fallback) clearSlideRoot(hostEl, "slideStrip");
      return;
    }
    const slidesByIndex = new Map(state.slides.slides.map((slide) => [slide.index, slide]));
    const slideTotal = state.slides.slides.length || slidesByIndex.size;
    let replacedCount = 0;
    for (const placeholder of Array.from(container.querySelectorAll("span.slideInline"))) {
      const index = Number(placeholder.getAttribute("data-slide-index"));
      const slide = slidesByIndex.get(index);
      if (!slide) continue;
      const wrapper = el("div", "slideInline");
      wrapper.dataset.slideIndex = String(index);
      const button = document.createElement("button");
      button.type = "button";
      const thumb = document.createElement("div");
      thumb.className = "slideInline__thumb isPlaceholder";
      const img = el("img", "slideInline__thumbImage");
      setUiAttribute(img, "alt", uiMessage("slides.imageAlt", { index }));
      updateThumb(img, thumb, slide.imageUrl);
      const caption = el("div", "slideCaption");
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
      clearSlideRoot(hostEl, "slideStrip");
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
      clearSlideRoot(hostEl, "slideGallery");
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
      clearSlideRoot(hostEl, "slideStrip");
      queueSlideGalleryRender();
      return;
    }
    clearSlideRoot(hostEl, "slideGallery");
    queueSlideStripRender();
  };

  const clear = () => {
    clearSlideRoot(hostEl, "slideStrip");
    clearSlideRoot(hostEl, "slideGallery");
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
