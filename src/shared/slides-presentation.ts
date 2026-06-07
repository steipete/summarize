import type { SummaryLength } from "./contracts.js";
import {
  buildSlideTextFallback,
  coerceSummaryWithSlides,
  parseSlideSummariesFromMarkdown,
  splitSlideTitleFromText,
  type SlideTimelineEntry,
} from "./slides-text.js";

export type SlidePresentationLength =
  | { kind: "preset"; preset: SummaryLength }
  | { kind: "chars"; maxCharacters: number };

export type SlidePresentationCard = {
  index: number;
  title: string | null;
  body: string;
  source: "summary" | "transcript";
};

export type SlidePresentation = {
  markdown: string;
  cards: SlidePresentationCard[];
  summaries: Map<number, string>;
  titles: Map<number, string>;
  finalSummaryIndexes: Set<number>;
};

export type SlidePresentationTextKind = "intro" | "slide-body";

const collapseWhitespace = (value: string): string => value.replace(/\s+/g, " ").trim();

export function buildSlidePresentation({
  markdown,
  slides,
  transcriptTimedText,
  lengthArg,
  coerce = true,
  coerceReserveIntro = true,
  includeTranscriptFallback = true,
}: {
  markdown: string;
  slides: SlideTimelineEntry[];
  transcriptTimedText?: string | null;
  lengthArg: SlidePresentationLength;
  coerce?: boolean;
  coerceReserveIntro?: boolean;
  includeTranscriptFallback?: boolean;
}): SlidePresentation {
  const ordered = slides.slice().sort((a, b) => a.index - b.index);
  const normalizedMarkdown =
    coerce && ordered.length > 0
      ? coerceSummaryWithSlides({
          markdown,
          slides: ordered,
          transcriptTimedText: includeTranscriptFallback ? transcriptTimedText : null,
          lengthArg,
          reserveIntro: coerceReserveIntro,
        })
      : markdown;
  const parsed = parseSlideSummariesFromMarkdown(normalizedMarkdown);
  const finalSummaryIndexes = new Set<number>();
  const cardsByIndex = new Map<number, SlidePresentationCard>();
  const summaries = new Map<number, string>();
  const titles = new Map<number, string>();
  const total = ordered.length || parsed.size;

  for (const [index, text] of parsed) {
    const parsedSlide = splitSlideTitleFromText({ text, slideIndex: index, total });
    const title = collapseWhitespace(parsedSlide.title ?? "") || null;
    const body = collapseWhitespace(parsedSlide.body ?? "");
    if (!body && !title) continue;
    finalSummaryIndexes.add(index);
    if (body) summaries.set(index, body);
    if (title) titles.set(index, title);
    cardsByIndex.set(index, { index, title, body, source: "summary" });
  }

  if (includeTranscriptFallback) {
    const fallback = buildSlideTextFallback({
      slides: ordered,
      transcriptTimedText,
      lengthArg,
    });
    for (const slide of ordered) {
      if (cardsByIndex.has(slide.index)) continue;
      const body = collapseWhitespace(fallback.get(slide.index) ?? "");
      if (!body) continue;
      cardsByIndex.set(slide.index, {
        index: slide.index,
        title: null,
        body,
        source: "transcript",
      });
    }
  }

  const order =
    ordered.length > 0 ? ordered.map((slide) => slide.index) : Array.from(cardsByIndex.keys());
  const cards = order
    .map((index) => cardsByIndex.get(index))
    .filter((card): card is SlidePresentationCard => Boolean(card));

  return {
    markdown: normalizedMarkdown,
    cards,
    summaries,
    titles,
    finalSummaryIndexes,
  };
}

export function createSlidesPresentationStream({
  getSlideIndexOrder,
  getSlideMeta,
  onText,
  onSlide,
  debugWrite,
}: {
  getSlideIndexOrder: () => number[];
  getSlideMeta?: ((index: number) => { total: number; timestamp: number | null }) | null;
  onText: (segment: string, kind: SlidePresentationTextKind) => void | Promise<void>;
  onSlide: (index: number, title?: string | null) => void | Promise<void>;
  debugWrite?: ((text: string) => void) | null;
}) {
  let buffered = "";
  const renderedSlides = new Set<number>();
  let pendingSlide: { index: number; buffer: string } | null = null;
  const slideTagRegex = /\[[^\]]*slide[^\d\]]*(\d+)[^\]]*\]/i;
  const slideLabelRegex =
    /(^|\n)[\t ]*slide\s+(\d+)(?:\s*(?:\/|of)\s*\d+)?(?:\s*[\u00b7:-].*)?(?=\n|$)/i;
  const bareSlideTagRegex = /(?<=^|\n)[\t ]*slide\s*:\s*(\d+)\](?=\s*(?:\n|$))/i;
  const slideStripRegex = /\[[^\]]*slide[^\]]*\]/gi;
  const bareSlideStripRegex = /(?<=^|\n)[\t ]*slide\s*:\s*\d+\](?=\s*(?:\n|$))/gi;

  const stripSlideMarkers = (segment: string) =>
    segment.replace(slideStripRegex, "").replace(bareSlideStripRegex, "");

  const renderSlideBlock = async (index: number, title?: string | null) => {
    if (renderedSlides.has(index)) return;
    renderedSlides.add(index);
    await onSlide(index, title);
  };

  const appendVisible = async (segment: string, kind: SlidePresentationTextKind = "intro") => {
    if (!segment) return;
    const sanitized = stripSlideMarkers(segment);
    if (!sanitized) return;
    if (pendingSlide) {
      pendingSlide.buffer += sanitized;
      await flushPendingSlide(false);
      return;
    }
    await onText(sanitized, kind);
  };

  const flushPendingSlide = async (force: boolean) => {
    if (!pendingSlide) return;
    const text = pendingSlide.buffer;
    if (!text.trim()) {
      if (force) {
        const index = pendingSlide.index;
        pendingSlide = null;
        await renderSlideBlock(index, null);
      }
      return;
    }

    const index = pendingSlide.index;
    const meta = getSlideMeta?.(index);
    const total = meta?.total ?? getSlideIndexOrder().length;
    const newlineIndex = text.indexOf("\n");
    const shouldResolve = force || newlineIndex !== -1 || text.length >= 160;
    if (!shouldResolve) return;

    const parsed = splitSlideTitleFromText({ text, slideIndex: index, total });
    if (parsed.title && !parsed.body && !force) return;

    pendingSlide = null;
    await renderSlideBlock(index, parsed.title ?? null);
    if (parsed.body.trim()) {
      await onText(parsed.body, "slide-body");
    }
  };

  const flushBuffered = async ({ final }: { final: boolean }) => {
    while (buffered.length > 0) {
      const tagMatch = slideTagRegex.exec(buffered);
      const labelMatch = slideLabelRegex.exec(buffered);
      const bareTagMatch = bareSlideTagRegex.exec(buffered);
      const lower = buffered.toLowerCase();
      const fallbackStart = lower.indexOf("[slide");
      const fallbackEnd = fallbackStart >= 0 ? buffered.indexOf("]", fallbackStart) : -1;
      const fallbackMatch =
        fallbackStart >= 0 && fallbackEnd > fallbackStart
          ? { start: fallbackStart, end: fallbackEnd }
          : null;
      const nextMatch =
        [
          tagMatch ? { kind: "tag" as const, index: tagMatch.index ?? 0, match: tagMatch } : null,
          labelMatch
            ? { kind: "label" as const, index: labelMatch.index ?? 0, match: labelMatch }
            : null,
          bareTagMatch
            ? { kind: "bare" as const, index: bareTagMatch.index ?? 0, match: bareTagMatch }
            : null,
          fallbackMatch
            ? { kind: "fallback" as const, index: fallbackMatch.start, match: fallbackMatch }
            : null,
        ]
          .filter(Boolean)
          .sort((a, b) => (a?.index ?? 0) - (b?.index ?? 0))[0] ?? null;

      if (!nextMatch) {
        if (final) {
          await appendVisible(buffered);
          buffered = "";
          return;
        }
        let start = lower.lastIndexOf("[slide");
        if (start === -1) {
          const bracket = lower.lastIndexOf("[");
          if (bracket !== -1) {
            const tail = lower.slice(bracket + 1).replace(/\s+/g, "");
            if (tail === "" || "slide".startsWith(tail)) start = bracket;
          }
        }
        if (start === -1) {
          await appendVisible(buffered);
          buffered = "";
          return;
        }
        const head = buffered.slice(0, start);
        await appendVisible(head);
        buffered = buffered.slice(start);
        return;
      }

      const matchIndex = nextMatch.kind === "fallback" ? nextMatch.match.start : nextMatch.index;
      const matchLength =
        nextMatch.kind === "fallback"
          ? nextMatch.match.end - nextMatch.match.start + 1
          : nextMatch.match[0].length;
      const rawTag = buffered.slice(matchIndex, matchIndex + matchLength);
      const before = buffered.slice(0, matchIndex);
      const after = buffered.slice(matchIndex + matchLength);
      if (pendingSlide) {
        await appendVisible(before);
        await flushPendingSlide(true);
      } else {
        await appendVisible(before);
      }
      buffered = after;

      let index: number | null = null;
      if (nextMatch.kind === "fallback") {
        const digitMatch = rawTag.match(/(\d+)/);
        index = digitMatch ? Number.parseInt(digitMatch[1] ?? "", 10) : null;
      } else {
        const rawIndex =
          nextMatch.kind === "tag"
            ? nextMatch.match[1]
            : nextMatch.kind === "label"
              ? (nextMatch.match[2] ?? nextMatch.match[1])
              : nextMatch.match[1];
        index = Number.parseInt(rawIndex ?? "", 10);
      }
      debugWrite?.(
        `slides marker: ${nextMatch.kind} raw=${JSON.stringify(rawTag)} index=${index ?? "null"}\n`,
      );
      if (Number.isFinite(index) && (index ?? 0) > 0) {
        pendingSlide = { index: index as number, buffer: "" };
      }
    }
  };

  return {
    async push(appended: string) {
      if (!appended) return;
      buffered += appended;
      await flushBuffered({ final: false });
    },
    async finish() {
      await flushBuffered({ final: true });
      if (pendingSlide) {
        await flushPendingSlide(true);
      }
      for (const index of getSlideIndexOrder()) {
        if (!renderedSlides.has(index)) {
          await renderSlideBlock(index, null);
        }
      }
    },
  };
}
