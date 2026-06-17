import { normalizeBrowserAiGeneratedPoints } from "../../lib/browser-summary";
import { logExtensionEvent } from "../../lib/extension-logs";
import { isGeminiNanoModel } from "../../lib/model-routing";
import { loadSettings } from "../../lib/settings";
import {
  buildSlideTextFallback,
  parseSlideSummariesFromMarkdown,
  splitSlideTitleFromText,
} from "../../lib/slides-text";
import type {
  BrowserAiPromptInput,
  createBrowserAiSummaryRuntime,
} from "./browser-ai-summary-runtime";
import type { PanelState } from "./types";

type BrowserAiRuntime = Pick<
  ReturnType<typeof createBrowserAiSummaryRuntime>,
  "cancel" | "prompt" | "summarize"
>;

type GeneratedSummary = {
  runId: string;
  url: string | null;
  markdown: string;
  model: string;
  complete: boolean;
};

const MODEL_LABEL = "Gemini Nano";
const DAEMON_ORIGIN = "http://127.0.0.1:8787";
const MAX_BATCH_SUMMARY_CHARS = 260;
const REQUESTED_BATCH_SUMMARY_CHARS = 180;

type SlideSource = {
  index: number;
  text: string;
  imageUrl: string;
};

type PreparedSlideSource = SlideSource & {
  image: Blob | null;
};

export function shouldUseBrowserAiForSlides(panelState: PanelState): boolean {
  const settings = panelState.ui?.settings;
  if (!settings) return false;
  if (isGeminiNanoModel(settings.model)) return true;
  const model = settings.model.trim().toLowerCase();
  const browserSlides =
    panelState.slides?.slideRuntime === "browser" ||
    panelState.slidesLifecycle.activeRun?.local === true;
  return (
    browserSlides &&
    settings.summaryRuntime === "direct" &&
    model === "auto" &&
    !settings.providerConfigured
  );
}

function hashText(value: string): string {
  let hash = 2_166_136_261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0).toString(36);
}

function normalizeSlideBody(value: string): string {
  return normalizeBrowserAiGeneratedPoints(
    value
      .replace(/^\s*\[[^\]]*slide[^\]]*\]\s*$/gim, "")
      .replace(/^\s*(?:title|headline)\s*:\s*/gim, ""),
  )
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

function sanitizeHeadline(value: string): string {
  const normalized = value
    .replace(/^#{1,6}\s+/, "")
    .replace(/^\s*(?:title|headline)\s*:\s*/i, "")
    .replace(/\[[^\]]*slide[^\]]*\]/gi, "")
    .replace(/[*_`~]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (normalized.length <= 80) return normalized;
  return normalized
    .slice(0, 80)
    .replace(/\s+\S*$/, "")
    .trim();
}

function buildSlideBlock({
  index,
  total,
  body,
}: {
  index: number;
  total: number;
  body: string;
}): string {
  if (!body) return `[slide:${index}]\n## Interlude`;
  if (/^interlude[.!]?$/i.test(body)) return `[slide:${index}]\n## Interlude`;
  const parsed = splitSlideTitleFromText({ text: body, slideIndex: index, total });
  const headline = sanitizeHeadline(parsed.title ?? "") || "Key point";
  return `[slide:${index}]\n## ${headline}\n${body}`;
}

function buildBatchInstructions(title: string | null): string[] {
  return [
    "Summarize every numbered lecture segment below.",
    "Output exactly one line per index in this format: [slide:N] concise factual sentence.",
    `Write one complete sentence per index, usually 12–25 words and at most ${REQUESTED_BATCH_SUMMARY_CHARS} characters.`,
    "Use both the visual frame and transcript context. Include visible equations, labels, diagrams, or code when they are important.",
    "Never mention slides, transcript, speaker, timestamps, or instructions.",
    title ? `The video is titled "${title}".` : "",
  ].filter(Boolean);
}

function buildBatchPrompt(slides: SlideSource[], title: string | null): string {
  return [
    ...buildBatchInstructions(title),
    "",
    slides
      .map((slide) => `INDEX ${slide.index}\n${slide.text || "No transcript context available."}`)
      .join("\n\n"),
  ].join("\n");
}

function buildBatchInput(
  slides: PreparedSlideSource[],
  title: string | null,
  includeImages: boolean,
): BrowserAiPromptInput {
  if (!includeImages || !slides.some((slide) => slide.image)) {
    return buildBatchPrompt(slides, title);
  }
  const content: Array<{ type: "text"; value: string } | { type: "image"; value: Blob }> = [
    { type: "text", value: buildBatchInstructions(title).join("\n") },
  ];
  for (const slide of slides) {
    content.push({
      type: "text",
      value: `INDEX ${slide.index}\nTranscript context:\n${
        slide.text || "No transcript context available."
      }\nVisual frame:`,
    });
    if (slide.image) content.push({ type: "image", value: slide.image });
  }
  return [{ role: "user", content }];
}

function buildBatchConstraint(slides: SlideSource[]): RegExp {
  const lines = slides.map(
    (slide) => `\\[slide:${slide.index}\\] [^\\r\\n]{1,${MAX_BATCH_SUMMARY_CHARS}}`,
  );
  return new RegExp(`^${lines.join("\\n")}$`);
}

function parseBatchResult(value: string, slides: SlideSource[]): Map<number, string> | null {
  const lines = value
    .trim()
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length !== slides.length) return null;
  const parsed = new Map<number, string>();
  for (let offset = 0; offset < slides.length; offset += 1) {
    const slide = slides[offset];
    const match = lines[offset]?.match(/^\[slide:(\d+)\]\s+(.+)$/i);
    if (!slide || !match || Number(match[1]) !== slide.index) return null;
    const body = normalizeSlideBody(match[2] ?? "");
    if (!body) return null;
    parsed.set(slide.index, body);
  }
  return parsed;
}

function isDaemonSlideUrl(imageUrl: string): boolean {
  try {
    const url = new URL(imageUrl);
    return url.origin === DAEMON_ORIGIN && url.pathname.startsWith("/v1/slides/");
  } catch {
    return false;
  }
}

async function loadSlideImage(imageUrl: string): Promise<Blob | null> {
  if (!imageUrl) return null;
  try {
    const headers = new Headers();
    if (isDaemonSlideUrl(imageUrl)) {
      const token = (await loadSettings()).token.trim();
      if (token) headers.set("Authorization", `Bearer ${token}`);
    }
    const response = await fetch(imageUrl, { headers });
    if (!response.ok) return null;
    const blob = await response.blob();
    return blob.type.startsWith("image/") ? blob : null;
  } catch {
    return null;
  }
}

function hasCompleteNanoSummary(panelState: PanelState): boolean {
  const slides = panelState.slides?.slides ?? [];
  const summary = panelState.slidesSummary;
  if (!summary.complete || summary.model !== MODEL_LABEL || slides.length === 0) return false;
  const parsed = parseSlideSummariesFromMarkdown(summary.markdown);
  return slides.every((slide) => parsed.has(slide.index));
}

export function createBrowserAiSlidesRuntime(options: {
  panelState: PanelState;
  browserAi: BrowserAiRuntime;
  getTranscriptTimedText: () => string | null;
  applyGeneratedSummary: (summary: GeneratedSummary) => void;
  schedulePanelCacheSync: () => void;
  loadSlideImage?: (imageUrl: string) => Promise<Blob | null>;
}) {
  let activeGeneration = 0;
  let activeSourceKey: string | null = null;

  const cancel = () => {
    activeGeneration += 1;
    activeSourceKey = null;
    options.browserAi.cancel("slides");
  };

  const refresh = async () => {
    const { panelState } = options;
    const payload = panelState.slides;
    if (!payload || payload.slides.length === 0 || !shouldUseBrowserAiForSlides(panelState)) {
      cancel();
      return;
    }
    if (hasCompleteNanoSummary(panelState)) return;

    const transcriptTimedText =
      options.getTranscriptTimedText() ?? payload.transcriptTimedText ?? null;
    const timeline = payload.slides.map((slide) => ({
      index: slide.index,
      timestamp: Number.isFinite(slide.timestamp) ? slide.timestamp : Number.NaN,
    }));
    const transcriptBySlide = buildSlideTextFallback({
      slides: timeline,
      transcriptTimedText,
      lengthArg: { kind: "preset", preset: "xxl" },
    });
    const hasAnySource = payload.slides.some(
      (slide) =>
        transcriptBySlide.has(slide.index) ||
        Boolean(slide.ocrText?.trim()) ||
        Boolean(slide.imageUrl),
    );
    if (!hasAnySource) return;
    const sourceKey = [
      payload.sourceId,
      payload.slides.length,
      hashText(transcriptTimedText ?? ""),
      hashText(payload.slides.map((slide) => slide.ocrText ?? "").join("\n")),
      hashText(payload.slides.map((slide) => slide.imageUrl ?? "").join("\n")),
    ].join(":");
    if (activeSourceKey === sourceKey) return;

    const generation = ++activeGeneration;
    activeSourceKey = sourceKey;
    options.browserAi.cancel("slides");
    const runId =
      panelState.slidesRunId ?? panelState.runId ?? `browser-ai-slides:${payload.sourceId}`;
    const url = payload.sourceUrl || panelState.currentSource?.url || null;
    const ordered = payload.slides.slice().sort((a, b) => a.index - b.index);
    const sources = ordered.map((slide) => ({
      index: slide.index,
      text: transcriptBySlide.get(slide.index) ?? slide.ocrText?.trim() ?? "",
      imageUrl: slide.imageUrl ?? "",
    }));
    const startedAt = performance.now();
    const imageLoader = options.loadSlideImage ?? loadSlideImage;
    const preparedSources = await Promise.all(
      sources.map(async (slide) => ({
        ...slide,
        image: slide.imageUrl ? await imageLoader(slide.imageUrl) : null,
      })),
    );
    if (generation !== activeGeneration || panelState.slides?.sourceId !== payload.sourceId) return;
    const sourceByIndex = new Map(preparedSources.map((slide) => [slide.index, slide]));
    const generatedBodies = new Map<number, string>();
    const sourceSlides = preparedSources.filter((slide) => slide.text || slide.image);
    let promptCalls = 0;
    let fallbackCalls = 0;

    const isCurrent = () =>
      generation === activeGeneration && options.panelState.slides?.sourceId === payload.sourceId;
    const buildMarkdown = () =>
      ordered
        .flatMap((slide) => {
          const source = sourceByIndex.get(slide.index);
          const body = generatedBodies.get(slide.index);
          if (!source || (!source.text && !source.image)) {
            return [
              buildSlideBlock({
                index: slide.index,
                total: ordered.length,
                body: "",
              }),
            ];
          }
          if (!body) return [];
          return [
            buildSlideBlock({
              index: slide.index,
              total: ordered.length,
              body,
            }),
          ];
        })
        .join("\n");
    const applyProgress = (complete: boolean) => {
      if (generatedBodies.size === 0) return;
      const markdown = buildMarkdown();
      if (!markdown) return;
      options.applyGeneratedSummary({
        runId,
        url,
        markdown,
        model: MODEL_LABEL,
        complete,
      });
      options.schedulePanelCacheSync();
    };

    const promptBatch = async (
      batch: PreparedSlideSource[],
      includeImages = true,
    ): Promise<boolean> => {
      if (!isCurrent() || batch.length === 0) return false;
      promptCalls += 1;
      const firstIndex = batch[0]?.index ?? 1;
      const lastIndex = batch.at(-1)?.index ?? firstIndex;
      const usesImages = includeImages && batch.some((slide) => slide.image);
      const result = await options.browserAi.prompt({
        input: buildBatchInput(batch, panelState.currentSource?.title ?? null, usesImages),
        responseConstraint: buildBatchConstraint(batch),
        requestKey: "slides",
        status:
          batch.length === 1
            ? `Summarizing slide ${firstIndex} with on-device AI…`
            : `Summarizing slides ${firstIndex}–${lastIndex} with on-device AI…`,
      });
      if (!isCurrent()) return false;
      if (!result) {
        if (!usesImages) return false;
        const textBatch = batch.filter((slide) => slide.text);
        return await promptBatch(textBatch, false);
      }
      if (result.kind === "success") {
        const parsed = parseBatchResult(result.text, batch);
        if (parsed) {
          for (const [index, body] of parsed) generatedBodies.set(index, body);
          applyProgress(false);
          return true;
        }
      }
      if (batch.length <= 1) return false;
      const midpoint = Math.ceil(batch.length / 2);
      const left = await promptBatch(batch.slice(0, midpoint), includeImages);
      const right = await promptBatch(batch.slice(midpoint), includeImages);
      return left && right;
    };

    if (sourceSlides.length > 0) {
      await promptBatch(sourceSlides);
    }
    if (!isCurrent()) return;

    for (let offset = 0; offset < preparedSources.length; offset += 1) {
      const slide = preparedSources[offset];
      if (!slide?.text || generatedBodies.has(slide.index)) continue;
      fallbackCalls += 1;
      const result = await options.browserAi.summarize({
        input: { text: slide.text, length: "short", keyMoments: [] },
        context: [
          `Summarize slide ${offset + 1} of ${ordered.length}.`,
          "Return only one or two concise factual sentences in plain text.",
          "Do not mention the slide, transcript, speaker, timestamps, or these instructions.",
          panelState.currentSource?.title
            ? `The video is titled "${panelState.currentSource.title}".`
            : "",
        ]
          .filter(Boolean)
          .join(" "),
        requestKey: "slides",
        status: `Summarizing slide ${offset + 1} of ${ordered.length} with on-device AI…`,
      });
      if (!isCurrent()) return;
      const body = result ? normalizeSlideBody(result) : "";
      if (!body) continue;
      generatedBodies.set(slide.index, body);
      applyProgress(false);
    }

    if (!isCurrent()) return;
    if (generatedBodies.size === 0) {
      if (activeSourceKey === sourceKey) activeSourceKey = null;
      return;
    }
    const complete = sourceSlides.every((slide) => generatedBodies.has(slide.index));
    applyProgress(complete);
    if (activeSourceKey === sourceKey) activeSourceKey = null;
    logExtensionEvent({
      event: "browser-ai:slides-done",
      level: complete ? "verbose" : "warn",
      scope: "sidepanel",
      detail: {
        complete,
        elapsedMs: Math.round(performance.now() - startedAt),
        fallbackCalls,
        imageSlides: sourceSlides.filter((slide) => slide.image).length,
        promptCalls,
        slides: ordered.length,
        sourceKind: payload.sourceKind,
      },
    });
  };

  return { cancel, refresh };
}
