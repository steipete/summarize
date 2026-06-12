export type { SlideTimelineEntry, TranscriptSegment } from "./text-types.js";

export {
  buildSlideTextFallback,
  coerceSummaryWithSlides,
  ensureSlideTitleLine,
  extractSlideMarkers,
  findSlidesSectionStart,
  normalizeSummarySlideHeadings,
  parseSlideSummariesFromMarkdown,
  splitSlideTitleFromText,
  splitSummaryFromSlides,
} from "./text-markdown.js";

export {
  buildTimestampUrl,
  formatOsc8Link,
  formatTimestamp,
  getTranscriptTextForSlide,
  interleaveSlidesIntoTranscript,
  parseTranscriptTimedText,
  resolveSlideTextBudget,
  resolveSlideWindowSeconds,
} from "./text-transcript.js";
