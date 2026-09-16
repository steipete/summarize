import type { SseSlidesData } from "@steipete/summarize-core/runtime";
import type { SummarizeEvent } from "../application/summarize-contracts.js";
import { cliMessage } from "../locale.js";
import { createCliTranslator, type CliMessage } from "../locale.js";
import { formatModelLabelForDisplay } from "../run/finish-line.js";
import type { SlideExtractionResult, SlideSourceKind } from "../slides/index.js";
import {
  emitMeta,
  emitSlides,
  emitSlidesDone,
  emitSlidesStatus,
  pushToSession,
  type Session,
  type SessionEvent,
} from "./server-session.js";
import { buildInputSummaryForExtracted } from "./summarize-presentation.js";
import { describeProgress, formatProgress } from "./summarize-progress.js";

type LoggerLike = {
  info?: (payload: Record<string, unknown>) => void;
};

export type SlidesLogShape = {
  enabled: boolean;
  ocr: boolean;
  outputDir: string;
  sceneThreshold: number | null;
  autoTuneThreshold: boolean;
  maxSlides: number | null;
  minDurationSeconds: number | null;
};

type SlideLogState = {
  startedAt: number | null;
  requested: boolean;
  cacheHit: boolean;
  lastStatus: string | null;
  statusCount: number;
  elapsedMs: number | null;
  slidesCount: number | null;
  ocrAvailable: boolean | null;
  warnings: string[];
};

export type DaemonSummarizeEventState = {
  emittedOutput: boolean;
  summaryFromCache: boolean;
  inputSummary: string | null;
  summaryText: string;
  extracted: Record<string, unknown> | null;
};

export function buildSlidesPayload({
  slides,
  port,
  transcriptTimedText,
}: {
  slides: SlideExtractionResult;
  port: number;
  transcriptTimedText?: string | null;
}): SseSlidesData {
  const baseUrl = `http://127.0.0.1:${port}/v1/slides/${slides.sourceId}`;
  return {
    sourceUrl: slides.sourceUrl,
    sourceId: slides.sourceId,
    sourceKind: slides.sourceKind,
    ocrAvailable: slides.ocrAvailable,
    transcriptTimedText: transcriptTimedText ?? null,
    slides: slides.slides.map((slide) => ({
      index: slide.index,
      timestamp: slide.timestamp,
      imageUrl: `${baseUrl}/${slide.index}${
        typeof slide.imageVersion === "number" && slide.imageVersion > 0
          ? `?v=${slide.imageVersion}`
          : ""
      }`,
      ocrText: slide.ocrText ?? null,
      ocrConfidence: slide.ocrConfidence ?? null,
    })),
  };
}

function createSlideLogState(requested: boolean): SlideLogState {
  return {
    startedAt: null,
    requested,
    cacheHit: false,
    lastStatus: null,
    statusCount: 0,
    elapsedMs: null,
    slidesCount: null,
    ocrAvailable: null,
    warnings: [],
  };
}

function createLiveSlides(meta: {
  slidesDir: string;
  sourceUrl: string;
  sourceId: string;
  sourceKind: SlideSourceKind;
  ocrAvailable: boolean;
}): SlideExtractionResult {
  return {
    sourceUrl: meta.sourceUrl,
    sourceKind: meta.sourceKind,
    sourceId: meta.sourceId,
    slidesDir: meta.slidesDir,
    sceneThreshold: 0,
    autoTuneThreshold: false,
    autoTune: {
      enabled: false,
      chosenThreshold: 0,
      confidence: 0,
      strategy: "none",
    },
    maxSlides: 0,
    minSlideDuration: 0,
    ocrRequested: meta.ocrAvailable,
    ocrAvailable: meta.ocrAvailable,
    slides: [],
    warnings: [],
  };
}

export function createDaemonSummarizeEventAdapter({
  session,
  pageUrl,
  slidesRequested,
  port,
  onSessionEvent,
  includeContentLog,
  requestLogger,
  logSlidesSettings,
}: {
  session: Session;
  pageUrl: string;
  slidesRequested: boolean;
  port: number;
  onSessionEvent?: ((event: SessionEvent, sessionId: string) => void) | null;
  includeContentLog: boolean;
  requestLogger?: LoggerLike | null;
  logSlidesSettings: SlidesLogShape | null;
}) {
  const state: DaemonSummarizeEventState = {
    emittedOutput: false,
    summaryFromCache: false,
    inputSummary: null,
    summaryText: "",
    extracted: null,
  };
  const slideLogState = createSlideLogState(slidesRequested);
  let liveSlides: SlideExtractionResult | null = null;

  const wireMessage = createCliTranslator("en");
  const writeStatus = (text: string, message?: CliMessage) => {
    const clean = (message ? wireMessage(message.key, message.values) : text).trim();
    if (!clean) return;
    pushToSession(
      session,
      { event: "status", data: { text: clean, ...(message ? { message } : {}) } },
      onSessionEvent,
    );
  };

  const startSlides = () => {
    if (!slideLogState.requested) return;
    slideLogState.startedAt = Date.now();
    console.log(`[summarize-daemon] slides: start url=${pageUrl} (session=${session.id})`);
    if (includeContentLog) {
      requestLogger?.info?.({
        event: "slides.start",
        url: pageUrl,
        sessionId: session.id,
        ...(logSlidesSettings ? { settings: logSlidesSettings } : {}),
      });
    }
  };

  const handleEvent = (event: SummarizeEvent) => {
    if (event.type === "summary-delta") {
      state.emittedOutput = true;
      if (includeContentLog) state.summaryText += event.text;
      pushToSession(session, { event: "chunk", data: { text: event.text } }, onSessionEvent);
      return;
    }
    if (event.type === "model-selected") {
      if (session.lastMeta.model === event.modelId) return;
      state.emittedOutput = true;
      emitMeta(
        session,
        { model: event.modelId, modelLabel: formatModelLabelForDisplay(event.modelId) },
        onSessionEvent,
      );
      return;
    }
    if (event.type === "extraction-started") {
      writeStatus("", cliMessage("progress.extractionActive"));
      return;
    }
    if (event.type === "extraction-progress") {
      const message = describeProgress(event.event);
      if (message) writeStatus("", message);
      else {
        const text = formatProgress(event.event);
        if (text) writeStatus(text);
      }
      return;
    }
    if (event.type === "content-extracted") {
      session.transcriptTimedText = event.content.transcriptTimedText ?? null;
      if (includeContentLog) {
        state.extracted = event.content as unknown as Record<string, unknown>;
      }
      const { inputSummary, inputSummaryMessage } = buildInputSummaryForExtracted(event.content);
      if (inputSummary) state.inputSummary = inputSummary;
      emitMeta(
        session,
        { inputSummary, inputSummaryMessage, summaryFromCache: null },
        onSessionEvent,
      );
      return;
    }
    if (event.type === "summary-started") {
      writeStatus("", cliMessage("progress.summaryActive"));
      return;
    }
    if (event.type === "summary-cache") {
      state.summaryFromCache = event.cached;
      emitMeta(session, { inputSummary: null, summaryFromCache: event.cached }, onSessionEvent);
      return;
    }
    if (event.type === "slides-extracted") {
      const { slides } = event;
      session.slides = slides;
      slideLogState.slidesCount = slides.slides.length;
      slideLogState.ocrAvailable = slides.ocrAvailable;
      slideLogState.warnings = slides.warnings;
      if (slideLogState.startedAt) {
        slideLogState.elapsedMs = Date.now() - slideLogState.startedAt;
        console.log(
          `[summarize-daemon] slides: done count=${slides.slides.length} ocr=${slides.ocrAvailable} elapsedMs=${slideLogState.elapsedMs} warnings=${slides.warnings.join("; ")}`,
        );
      }
      if (includeContentLog) {
        requestLogger?.info?.({
          event: "slides.done",
          url: pageUrl,
          sessionId: session.id,
          slidesCount: slides.slides.length,
          ocrAvailable: slides.ocrAvailable,
          elapsedMs: slideLogState.elapsedMs,
          cacheHit: slideLogState.cacheHit,
          warnings: slides.warnings,
        });
      }
      emitSlides(
        session,
        buildSlidesPayload({
          slides,
          port,
          transcriptTimedText: session.transcriptTimedText,
        }),
        onSessionEvent,
      );
      return;
    }
    if (event.type === "slides-completed") {
      emitSlidesDone(session, { ok: event.ok, error: event.error }, onSessionEvent);
      return;
    }
    if (event.type === "slides-progress") {
      const clean = (
        event.message ? wireMessage(event.message.key, event.message.values) : event.text
      ).trim();
      if (!clean) return;
      slideLogState.lastStatus = clean;
      slideLogState.statusCount += 1;
      if (clean.toLowerCase().includes("cached")) {
        slideLogState.cacheHit = true;
      }
      const progressMatch = clean.match(/(\d+)%/);
      const progress =
        typeof event.message?.values.percent === "number"
          ? event.message.values.percent * 100
          : progressMatch
            ? Number(progressMatch[1])
            : null;
      if (includeContentLog) {
        requestLogger?.info?.({
          event: "slides.status",
          url: pageUrl,
          sessionId: session.id,
          status: clean,
          ...(progress !== null ? { progress } : {}),
        });
      }
      emitSlidesStatus(session, clean, onSessionEvent, event.message);
      writeStatus(clean, event.message);
      return;
    }
    if (event.type !== "slide") return;

    const { slide, meta } = event;
    if (!slide || !meta?.slidesDir || !meta.sourceUrl || !meta.sourceId || !meta.sourceKind) {
      return;
    }
    const nextSlides = liveSlides ?? createLiveSlides(meta);
    liveSlides = nextSlides;
    const existingIndex = nextSlides.slides.findIndex((item) => item.index === slide.index);
    if (existingIndex >= 0) {
      nextSlides.slides[existingIndex] = {
        ...nextSlides.slides[existingIndex],
        ...slide,
      };
    } else {
      nextSlides.slides.push(slide);
    }
    nextSlides.slides.sort((a, b) => a.index - b.index);
    session.slides = nextSlides;
    emitSlides(
      session,
      buildSlidesPayload({
        slides: nextSlides,
        port,
        transcriptTimedText: session.transcriptTimedText,
      }),
      onSessionEvent,
    );
  };

  const serializeSlides = () => ({
    requested: true,
    cacheHit: slideLogState.cacheHit,
    lastStatus: slideLogState.lastStatus,
    statusCount: slideLogState.statusCount,
    elapsedMs: slideLogState.elapsedMs,
    slidesCount: slideLogState.slidesCount,
    ocrAvailable: slideLogState.ocrAvailable,
    warnings: slideLogState.warnings,
  });

  return {
    state,
    writeStatus,
    startSlides,
    handleEvent,
    serializeSlides,
  };
}
