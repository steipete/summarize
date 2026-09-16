import { setText as setUiText, resolveText, subscribeLocale } from "../../lib/i18n";
import { buildMetricsParts, buildMetricsTokens, type LocalizedMetricPart } from "../../lib/metrics";

export type MetricsMode = "summary" | "chat";

type MetricsState = {
  parts?: LocalizedMetricPart[] | null;
  summary: string | null;
  inputSummary: string | null;
  sourceUrl: string | null;
};

type MetricsRenderState = {
  parts?: LocalizedMetricPart[] | null;
  summary: string | null;
  inputSummary: string | null;
  sourceUrl: string | null;
  shortened: boolean;
  rafId: number | null;
  observer: ResizeObserver | null;
};

function getLineHeightPx(el: HTMLElement, styles?: CSSStyleDeclaration): number {
  const resolved = styles ?? getComputedStyle(el);
  const lineHeightRaw = resolved.lineHeight;
  const fontSize = Number.parseFloat(resolved.fontSize) || 0;
  if (lineHeightRaw === "normal") return fontSize * 1.2;
  const parsed = Number.parseFloat(lineHeightRaw);
  return Number.isFinite(parsed) ? parsed : 0;
}

function elementWrapsToMultipleLines(el: HTMLElement): boolean {
  if (el.getClientRects().length === 0) return false;
  const styles = getComputedStyle(el);
  const lineHeight = getLineHeightPx(el, styles);
  if (!lineHeight) return false;

  const paddingTop = Number.parseFloat(styles.paddingTop) || 0;
  const paddingBottom = Number.parseFloat(styles.paddingBottom) || 0;
  const borderTop = Number.parseFloat(styles.borderTopWidth) || 0;
  const borderBottom = Number.parseFloat(styles.borderBottomWidth) || 0;
  const totalHeight = el.getBoundingClientRect().height;
  const contentHeight = Math.max(
    0,
    totalHeight - paddingTop - paddingBottom - borderTop - borderBottom,
  );

  return contentHeight > lineHeight * 1.4;
}

export function createMetricsController({
  metricsEl,
  metricsHomeEl,
  chatMetricsSlotEl,
}: {
  metricsEl: HTMLDivElement;
  metricsHomeEl: HTMLDivElement;
  chatMetricsSlotEl: HTMLDivElement;
}) {
  const renderState: MetricsRenderState = {
    summary: null,
    inputSummary: null,
    sourceUrl: null,
    shortened: false,
    rafId: null,
    observer: null,
  };

  const metricsByMode: Record<MetricsMode, MetricsState> = {
    summary: { summary: null, inputSummary: null, sourceUrl: null },
    chat: { summary: null, inputSummary: null, sourceUrl: null },
  };

  let activeMode: MetricsMode = "summary";
  let metricsMeasureEl: HTMLDivElement | null = null;

  const ensureMetricsMeasureEl = (): HTMLDivElement => {
    if (metricsMeasureEl) return metricsMeasureEl;
    const el = document.createElement("div");
    el.style.position = "absolute";
    el.style.visibility = "hidden";
    el.style.pointerEvents = "none";
    el.style.left = "-99999px";
    el.style.top = "0";
    el.style.padding = "0";
    el.style.border = "0";
    el.style.margin = "0";
    el.style.whiteSpace = "normal";
    el.style.boxSizing = "content-box";
    document.body.append(el);
    metricsMeasureEl = el;
    return el;
  };

  const syncMetricsMeasureStyles = () => {
    if (!metricsMeasureEl) return;
    const styles = getComputedStyle(metricsEl);
    metricsMeasureEl.style.fontFamily = styles.fontFamily;
    metricsMeasureEl.style.fontSize = styles.fontSize;
    metricsMeasureEl.style.fontWeight = styles.fontWeight;
    metricsMeasureEl.style.fontStyle = styles.fontStyle;
    metricsMeasureEl.style.fontVariant = styles.fontVariant;
    metricsMeasureEl.style.lineHeight = styles.lineHeight;
    metricsMeasureEl.style.letterSpacing = styles.letterSpacing;
    metricsMeasureEl.style.wordSpacing = styles.wordSpacing;
    metricsMeasureEl.style.textTransform = styles.textTransform;
    metricsMeasureEl.style.textIndent = styles.textIndent;
    metricsMeasureEl.style.wordBreak = styles.wordBreak;
    metricsMeasureEl.style.whiteSpace = styles.whiteSpace;
    metricsMeasureEl.style.width = `${metricsEl.clientWidth}px`;
  };

  const renderSummary = (
    summary: string,
    options?: {
      shortenOpenRouter?: boolean;
      inputSummary?: string | null;
      sourceUrl?: string | null;
    },
  ) => {
    metricsEl.replaceChildren();
    if (renderState.parts) {
      renderState.parts.forEach((part, index) => {
        if (index) metricsEl.append(document.createTextNode(" · "));
        const element = document.createElement(part.href ? "a" : "span");
        if (part.href && element instanceof HTMLAnchorElement) {
          element.href = part.href;
          element.target = "_blank";
          element.rel = "noopener noreferrer";
        }
        const text =
          options?.shortenOpenRouter && part.model && typeof part.text === "string"
            ? part.text.replace(
                /^openrouter\//iu,
                /* i18n-ignore: Compact provider prefix in a literal model ID. */ "or/",
              )
            : part.text;
        setUiText(element, text);
        metricsEl.append(element);
      });
      return;
    }
    const tokens = buildMetricsTokens({
      summary,
      inputSummary: options?.inputSummary ?? renderState.inputSummary,
      sourceUrl: options?.sourceUrl ?? renderState.sourceUrl,
      shortenOpenRouter: options?.shortenOpenRouter ?? false,
    });

    tokens.forEach((token, index) => {
      if (index) metricsEl.append(document.createTextNode(" · "));
      if (token.kind === "link") {
        const link = document.createElement("a");
        link.href = token.href;
        setUiText(link, token.text);
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        metricsEl.append(link);
        return;
      }
      if (token.kind === "media") {
        if (token.before) metricsEl.append(document.createTextNode(token.before));
        const link = document.createElement("a");
        link.href = token.href;
        setUiText(link, token.label);
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        metricsEl.append(link);
        if (token.after) metricsEl.append(document.createTextNode(token.after));
        return;
      }
      metricsEl.append(document.createTextNode(token.text));
    });
  };

  const scheduleFitCheck = () => {
    if (!renderState.summary) return;
    if (renderState.rafId != null) return;
    renderState.rafId = window.requestAnimationFrame(() => {
      renderState.rafId = null;
      if (!renderState.summary) return;
      const parts =
        renderState.parts?.map((part) => resolveText(part.text)) ??
        buildMetricsParts({
          summary: renderState.summary,
          inputSummary: renderState.inputSummary,
        });
      if (parts.length === 0) return;
      const fullText = parts.join(" · ");
      if (!/\bopenrouter\//i.test(fullText)) return;
      if (metricsEl.clientWidth <= 0) return;
      const measureEl = ensureMetricsMeasureEl();
      syncMetricsMeasureStyles();
      setUiText(measureEl, fullText);
      const shouldShorten = elementWrapsToMultipleLines(measureEl);
      if (shouldShorten === renderState.shortened) return;
      renderState.shortened = shouldShorten;
      renderSummary(renderState.summary, {
        shortenOpenRouter: shouldShorten,
        inputSummary: renderState.inputSummary,
        sourceUrl: renderState.sourceUrl,
      });
    });
  };

  const ensureObserver = () => {
    if (renderState.observer) return;
    renderState.observer = new ResizeObserver(() => {
      scheduleFitCheck();
    });
    renderState.observer.observe(metricsEl);
  };

  const moveTo = (mode: MetricsMode) => {
    const target = mode === "chat" ? chatMetricsSlotEl : metricsHomeEl;
    if (metricsEl.parentElement !== target) {
      target.append(metricsEl);
    }
    activeMode = mode;
  };

  const renderMode = (mode: MetricsMode) => {
    const state = metricsByMode[mode];
    renderState.summary = state.summary;
    renderState.parts = state.parts;
    renderState.inputSummary = state.inputSummary;
    renderState.sourceUrl = state.sourceUrl;
    renderState.shortened = false;

    if (mode === "chat") {
      chatMetricsSlotEl.classList.toggle("isVisible", Boolean(state.summary));
    } else {
      chatMetricsSlotEl.classList.remove("isVisible");
    }

    metricsEl.removeAttribute("title");
    metricsEl.removeAttribute("data-details");

    if (!state.summary) {
      setUiText(metricsEl, "");
      metricsEl.classList.add("hidden");
      return;
    }

    renderSummary(state.summary, {
      inputSummary: state.inputSummary,
      sourceUrl: state.sourceUrl,
    });
    metricsEl.classList.remove("hidden");
    ensureObserver();
    scheduleFitCheck();
  };

  const unsubscribe = subscribeLocale(() => renderMode(activeMode));
  const dispose = () => {
    unsubscribe();
    renderState.observer?.disconnect();
    if (renderState.rafId !== null) window.cancelAnimationFrame(renderState.rafId);
    metricsMeasureEl?.remove();
    window.removeEventListener("pagehide", dispose);
  };
  window.addEventListener("pagehide", dispose, { once: true });

  return {
    dispose,
    clearForMode(mode: MetricsMode) {
      this.setForMode(mode, null, null, null);
    },
    setActiveMode(mode: MetricsMode) {
      moveTo(mode);
      renderMode(mode);
    },
    setForMode(
      mode: MetricsMode,
      summary: string | null,
      inputSummary: string | null,
      sourceUrl: string | null,
      parts?: LocalizedMetricPart[] | null,
    ) {
      metricsByMode[mode] = { summary, inputSummary, sourceUrl, parts };
      if (activeMode === mode) {
        renderMode(mode);
      }
    },
  };
}
