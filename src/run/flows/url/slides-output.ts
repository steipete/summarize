import type { SummaryLength } from "@steipete/summarize-core";
import type { ExtractedLinkContent } from "../../../content/index.js";
import type { SlideExtractionResult, SlideImage, SlideSourceKind } from "../../../slides/index.js";
import {
  createThemeRenderer,
  resolveThemeNameFromSources,
  resolveTrueColor,
} from "../../../tty/theme.js";
import { createSlidesInlineRenderer } from "../../slides-render.js";
import type { StreamOutputMode } from "../../stream-output.js";
import type { SummaryStreamHandler } from "../../summary-engine.js";
import { isRichTty, supportsColor } from "../../terminal.js";
import {
  createInlineSlidesUnsupportedNotifier,
  createSlidesTerminalRenderer,
} from "./slides-output-render.js";
import { createSlideOutputState } from "./slides-output-state.js";
import { createSlidesSummaryStreamHandler } from "./slides-output-stream.js";
export { createSlidesSummaryStreamHandler } from "./slides-output-stream.js";

export type SlidesTerminalOutput = {
  onSlidesExtracted: (slides: SlideExtractionResult) => void;
  onSlidesDone: (result: { ok: boolean; error?: string | null }) => void;
  onSlideChunk: (chunk: {
    slide: SlideImage;
    meta: {
      slidesDir: string;
      sourceUrl: string;
      sourceId: string;
      sourceKind: SlideSourceKind;
      ocrAvailable: boolean;
    };
  }) => void;
  streamHandler: SummaryStreamHandler;
  renderFromText: (summary: string) => Promise<void>;
};

export function createSlidesTerminalOutput({
  io,
  flags,
  extracted,
  slides,
  enabled,
  outputMode,
  clearProgressForStdout,
  restoreProgressAfterStdout,
  onProgressText,
}: {
  io: {
    env: Record<string, string | undefined>;
    envForRun: Record<string, string | undefined>;
    stdout: NodeJS.WritableStream;
    stderr: NodeJS.WritableStream;
  };
  flags: {
    plain: boolean;
    lengthArg: { kind: "preset"; preset: SummaryLength } | { kind: "chars"; maxCharacters: number };
    slidesDebug?: boolean;
  };
  extracted: ExtractedLinkContent;
  slides: SlideExtractionResult | null | undefined;
  enabled: boolean;
  outputMode?: StreamOutputMode | null;
  clearProgressForStdout: () => void;
  restoreProgressAfterStdout?: (() => void) | null;
  onProgressText?: ((text: string) => void) | null;
}): SlidesTerminalOutput | null {
  if (!enabled) return null;
  const inlineRenderer = !flags.plain
    ? createSlidesInlineRenderer({ mode: "auto", env: io.envForRun, stdout: io.stdout })
    : null;
  const inlineProtocol = inlineRenderer?.protocol ?? "none";
  const inlineEnabled = inlineProtocol !== "none";
  const inlineNoticeEnabled = !flags.plain && !inlineEnabled;
  const labelTheme = createThemeRenderer({
    themeName: resolveThemeNameFromSources({ env: io.envForRun.SUMMARIZE_THEME }),
    enabled: supportsColor(io.stdout, io.envForRun) && !flags.plain,
    trueColor: resolveTrueColor(io.envForRun),
  });

  const state = createSlideOutputState(slides);
  state.setMeta({ sourceUrl: extracted.url });
  const noteInlineUnsupported = createInlineSlidesUnsupportedNotifier({
    inlineNoticeEnabled,
    flags,
    io: { stderr: io.stderr },
    richTty: isRichTty(io.stdout),
    clearProgressForStdout,
    restoreProgressAfterStdout,
  });

  const onSlidesExtracted = (nextSlides: SlideExtractionResult) => {
    state.updateFromSlides(nextSlides);
    noteInlineUnsupported(nextSlides);
  };

  const onSlideChunk = (chunk: {
    slide: SlideImage;
    meta: { slidesDir: string; sourceUrl: string };
  }) => {
    state.setMeta({ slidesDir: chunk.meta?.slidesDir, sourceUrl: chunk.meta?.sourceUrl });
    state.updateSlideEntry(chunk.slide);
  };

  const onSlidesDone = (_result: { ok: boolean; error?: string | null }) => {
    state.markDone();
  };

  const renderSlide = createSlidesTerminalRenderer({
    io,
    flags,
    inlineEnabled,
    richTty: isRichTty(io.stdout) && !flags.plain,
    inlineRenderer,
    labelTheme,
    clearProgressForStdout,
    restoreProgressAfterStdout,
    onProgressText,
    getOrder: () => state.getOrder(),
    getSlide: (index) => state.getSlide(index),
    getSourceUrl: () => state.getSourceUrl(),
    waitForSlide: (index) => state.waitForSlide(index),
    initialSlides: slides,
  });

  const streamHandler: SummaryStreamHandler = createSlidesSummaryStreamHandler({
    stdout: io.stdout,
    env: io.env,
    envForRun: io.envForRun,
    plain: flags.plain,
    outputMode: outputMode ?? "line",
    clearProgressForStdout,
    restoreProgressAfterStdout,
    renderSlide,
    getSlideIndexOrder: () => state.getOrder(),
    getSlideMeta: (index) => {
      const total = state.getOrder().length || (slides?.slides.length ?? 0);
      const slide = state.getSlide(index);
      const timestamp =
        typeof slide?.timestamp === "number" && Number.isFinite(slide.timestamp)
          ? slide.timestamp
          : null;
      return { total, timestamp };
    },
    debugWrite:
      io.envForRun.SUMMARIZE_DEBUG_SLIDE_MARKERS &&
      io.envForRun.SUMMARIZE_DEBUG_SLIDE_MARKERS !== "0"
        ? (text: string) => io.stderr.write(text)
        : null,
  });

  const renderFromText = async (text: string) => {
    await streamHandler.onChunk({ streamed: text, prevStreamed: "", appended: text });
    await streamHandler.onDone?.(text);
  };

  return {
    onSlidesExtracted,
    onSlidesDone,
    onSlideChunk,
    streamHandler,
    renderFromText,
  };
}
