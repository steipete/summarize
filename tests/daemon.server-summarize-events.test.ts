import { describe, expect, it, vi } from "vitest";
import type { ExtractedLinkContent } from "../src/content/index.js";
import { createSession } from "../src/daemon/server-session.js";
import { createDaemonSummarizeEventAdapter } from "../src/daemon/server-summarize-events.js";
import type { SlideExtractionResult } from "../src/slides/index.js";

const extracted: ExtractedLinkContent = {
  url: "https://example.com/article",
  title: "Article",
  description: null,
  siteName: "Example",
  content: "A short article body.",
  truncated: false,
  totalCharacters: 21,
  wordCount: 4,
  transcriptCharacters: null,
  transcriptLines: null,
  transcriptWordCount: null,
  transcriptSource: null,
  transcriptionProvider: null,
  transcriptMetadata: null,
  transcriptSegments: null,
  transcriptTimedText: null,
  mediaDurationSeconds: null,
  video: null,
  isVideoOnly: false,
  diagnostics: {
    strategy: "html",
    firecrawl: { attempted: false, used: false, cacheMode: "bypass", cacheStatus: "unknown" },
    markdown: { requested: false, used: false, provider: null },
    transcript: {
      cacheMode: "bypass",
      cacheStatus: "unknown",
      textProvided: false,
      provider: null,
      attemptedProviders: [],
    },
  },
};

const slides: SlideExtractionResult = {
  sourceUrl: "https://example.com/video.mp4",
  sourceKind: "direct",
  sourceId: "video-1",
  slidesDir: "/tmp/slides/video-1",
  sceneThreshold: 0.3,
  autoTuneThreshold: false,
  autoTune: {
    enabled: false,
    chosenThreshold: 0.3,
    confidence: 0,
    strategy: "none",
  },
  maxSlides: 10,
  minSlideDuration: 2,
  ocrRequested: true,
  ocrAvailable: true,
  slides: [
    {
      index: 1,
      timestamp: 5,
      imagePath: "/tmp/slides/video-1/slide_0001.png",
      imageVersion: 2,
      ocrText: "Opening",
      ocrConfidence: 0.9,
    },
  ],
  warnings: [],
};

function createAdapter(options?: { slidesRequested?: boolean; includeContentLog?: boolean }) {
  const session = createSession(() => "summary-1");
  const onSessionEvent = vi.fn();
  const requestLogger = { info: vi.fn() };
  const adapter = createDaemonSummarizeEventAdapter({
    session,
    pageUrl: extracted.url,
    slidesRequested: options?.slidesRequested ?? false,
    port: 3210,
    onSessionEvent,
    includeContentLog: options?.includeContentLog ?? true,
    requestLogger,
    logSlidesSettings: null,
  });
  return { adapter, session, onSessionEvent, requestLogger };
}

describe("daemon summarize event adapter", () => {
  it("keeps legacy input summaries alongside numeric localized descriptors", () => {
    const { adapter, session } = createAdapter();
    adapter.handleEvent({
      type: "content-extracted",
      content: { ...extracted, wordCount: 1234, totalCharacters: 12000 },
    });
    expect(session.lastMeta).toMatchObject({
      inputSummary: "1.2k words · 12k chars",
      inputSummaryMessage: { key: "input.summary", values: { words: 1234, chars: 12000 } },
    });
  });
  it("translates semantic summary events and retains logging state", () => {
    const { adapter, session, onSessionEvent } = createAdapter();

    adapter.handleEvent({ type: "extraction-started", url: extracted.url });
    adapter.handleEvent({ type: "content-extracted", content: extracted });
    adapter.handleEvent({ type: "summary-started" });
    adapter.handleEvent({ type: "model-selected", modelId: "openai/gpt-5.2" });
    adapter.handleEvent({ type: "summary-cache", cached: false });
    adapter.handleEvent({ type: "summary-delta", text: "Summary text." });

    expect(session.summaryEvents.buffer.map(({ event }) => event.event)).toEqual([
      "status",
      "meta",
      "status",
      "meta",
      "meta",
      "chunk",
    ]);
    expect(session.lastMeta).toMatchObject({
      model: "openai/gpt-5.2",
      inputSummary: "4 words · 21 chars",
      summaryFromCache: false,
    });
    expect(adapter.state).toMatchObject({
      emittedOutput: true,
      summaryFromCache: false,
      inputSummary: "4 words · 21 chars",
      summaryText: "Summary text.",
      extracted,
    });
    expect(onSessionEvent).toHaveBeenCalledTimes(6);
  });

  it("fans slide events into both channels and exposes slide log state", () => {
    const { adapter, session, requestLogger } = createAdapter({ slidesRequested: true });

    adapter.handleEvent({ type: "slides-progress", text: "Cached slides 50%" });
    adapter.handleEvent({ type: "slides-extracted", slides });
    adapter.handleEvent({ type: "slides-completed", ok: true });

    expect(session.summaryEvents.buffer.map(({ event }) => event.event)).toEqual([
      "status",
      "slides",
    ]);
    expect(session.slideEvents.buffer.map(({ event }) => event.event)).toEqual([
      "status",
      "slides",
      "done",
    ]);
    expect(session.slides).toBe(slides);
    expect(session.summaryEvents.buffer[1]?.event).toMatchObject({
      event: "slides",
      data: {
        sourceId: "video-1",
        slides: [{ imageUrl: "http://127.0.0.1:3210/v1/slides/video-1/1?v=2" }],
      },
    });
    expect(adapter.serializeSlides()).toMatchObject({
      requested: true,
      cacheHit: true,
      lastStatus: "Cached slides 50%",
      statusCount: 1,
      slidesCount: 1,
      ocrAvailable: true,
    });
    expect(requestLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({ event: "slides.status", progress: 50 }),
    );
    expect(requestLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({ event: "slides.done", slidesCount: 1 }),
    );
  });
});
