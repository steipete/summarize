import type { SummaryLength } from "../shared/contracts.js";
import {
  ensureSlideTitleLine,
  isInterludeSlideText,
  isTitleOnlySlideText,
  parseSlideSummariesFromMarkdown,
  splitSlideTitleFromText,
  splitSummaryFromSlides,
  stripSlideTitleList,
} from "./text-markdown.js";
import {
  getTranscriptTextForSlide,
  parseTranscriptTimedText,
  resolveSlideTextBudget,
  resolveSlideWindowSeconds,
} from "./text-transcript.js";
import type { SlideTimelineEntry } from "./text-types.js";

function splitMarkdownParagraphs(markdown: string): string[] {
  return markdown
    .split(/\n\s*\n+/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function pickIntroParagraph(markdown: string): string {
  const paragraphs = splitMarkdownParagraphs(markdown);
  if (paragraphs.length === 0) return "";
  const firstNonHeading =
    paragraphs.find((paragraph) => !/^#{1,6}\s+\S/.test(paragraph.trim())) ?? paragraphs[0];
  if (!firstNonHeading) return "";
  const sentences = firstNonHeading.match(/[^.!?]+[.!?]+|[^.!?]+$/g) ?? [firstNonHeading];
  if (sentences.length <= 3) return firstNonHeading.trim();
  return sentences.slice(0, 3).join(" ").trim();
}

export function buildSlideTextFallback({
  slides,
  transcriptTimedText,
  lengthArg,
}: {
  slides: SlideTimelineEntry[];
  transcriptTimedText: string | null | undefined;
  lengthArg: { kind: "preset"; preset: SummaryLength } | { kind: "chars"; maxCharacters: number };
}): Map<number, string> {
  const map = new Map<number, string>();
  if (!transcriptTimedText || !transcriptTimedText.trim()) return map;
  if (slides.length === 0) return map;
  const segments = parseTranscriptTimedText(transcriptTimedText);
  if (segments.length === 0) return map;
  const ordered = slides.slice().sort((a, b) => a.index - b.index);
  const budget = resolveSlideTextBudget({ lengthArg, slideCount: ordered.length });
  const windowSeconds = resolveSlideWindowSeconds({ lengthArg });
  for (let i = 0; i < ordered.length; i += 1) {
    const slide = ordered[i];
    if (!slide) continue;
    const nextSlide = i + 1 < ordered.length ? (ordered[i + 1] ?? null) : null;
    const text = getTranscriptTextForSlide({
      slide,
      nextSlide,
      segments,
      budget,
      windowSeconds,
    });
    if (text) map.set(slide.index, text);
  }
  return map;
}

export function coerceSummaryWithSlides({
  markdown,
  slides,
  transcriptTimedText,
  lengthArg,
  reserveIntro = true,
}: {
  markdown: string;
  slides: SlideTimelineEntry[];
  transcriptTimedText?: string | null;
  lengthArg: { kind: "preset"; preset: SummaryLength } | { kind: "chars"; maxCharacters: number };
  reserveIntro?: boolean;
}): string {
  if (!markdown.trim() || slides.length === 0) return markdown;
  const ordered = slides.slice().sort((a, b) => a.index - b.index);
  const { summary, slidesSection } = splitSummaryFromSlides(markdown);
  const intro = reserveIntro ? pickIntroParagraph(summary) : "";
  const slideSummaries = slidesSection ? parseSlideSummariesFromMarkdown(markdown) : new Map();
  const interludeSlideIndexes = new Set(
    Array.from(slideSummaries.entries())
      .filter(([, text]) => isInterludeSlideText(text))
      .map(([index]) => index),
  );
  const titleOnlySlideSummaries =
    slideSummaries.size > 0 &&
    Array.from(slideSummaries.values()).every((text) => isTitleOnlySlideText(text));
  const distributionMarkdown = titleOnlySlideSummaries ? stripSlideTitleList(markdown) : markdown;
  const fallbackSummaries = buildSlideTextFallback({
    slides: ordered,
    transcriptTimedText,
    lengthArg,
  });

  const hasDetailedSummaries = slideSummaries.size > 0 && !titleOnlySlideSummaries;
  const paragraphs = splitMarkdownParagraphs(hasDetailedSummaries ? summary : distributionMarkdown);
  if (!hasDetailedSummaries && paragraphs.length === 0) return markdown;
  if (!hasDetailedSummaries && ordered.every((slide) => interludeSlideIndexes.has(slide.index))) {
    return [intro.trim(), ...ordered.map((slide) => `[slide:${slide.index}]\n## Interlude`)]
      .filter(Boolean)
      .join("\n\n");
  }
  const introParagraph = reserveIntro ? intro || paragraphs[0] || "" : "";
  const introIndex = introParagraph ? paragraphs.indexOf(introParagraph) : -1;
  const remaining = reserveIntro
    ? introIndex >= 0
      ? paragraphs.filter((_, index) => index !== introIndex)
      : paragraphs.slice(1)
    : paragraphs;
  const distributableSlides = ordered.filter((slide) => !interludeSlideIndexes.has(slide.index));
  const total = (distributableSlides.length > 0 ? distributableSlides : ordered).length;

  if (hasDetailedSummaries) {
    const parts: string[] = [];
    if (intro) parts.push(intro);
    const distributedSummaries = new Map<number, string>();
    if (remaining.length > 0) {
      let distributionIndex = 0;
      for (const slide of ordered) {
        if (interludeSlideIndexes.has(slide.index) && distributableSlides.length > 0) continue;
        const segment = distributeParagraphs(remaining, distributionIndex++, total);
        if (segment) distributedSummaries.set(slide.index, segment);
      }
    }
    for (const slide of ordered) {
      const directText = slideSummaries.get(slide.index);
      const directBody = directText
        ? splitSlideTitleFromText({
            text: directText,
            slideIndex: slide.index,
            total: ordered.length,
          }).body.trim()
        : "";
      const distributedText = distributedSummaries.get(slide.index) ?? "";
      const fallbackText = slideSummaries.has(slide.index)
        ? ""
        : (fallbackSummaries.get(slide.index) ?? "");
      const directOutput = directBody || isInterludeSlideText(directText ?? "") ? directText : "";
      const text = directOutput || distributedText || fallbackText;
      const withTitle = text ? ensureSlideTitleLine({ text, slide, total: ordered.length }) : "";
      parts.push(withTitle ? `[slide:${slide.index}]\n${withTitle}` : `[slide:${slide.index}]`);
    }
    return parts.join("\n\n");
  }

  const parts: string[] = [];
  if (introParagraph) parts.push(introParagraph.trim());
  const slideTotal = ordered.length;
  let distributionIndex = 0;
  for (const slide of ordered) {
    const slideIndex = slide.index;
    if (interludeSlideIndexes.has(slideIndex) && distributableSlides.length > 0) {
      parts.push(`[slide:${slideIndex}]\n## Interlude`);
      continue;
    }
    const segment = distributeParagraphs(remaining, distributionIndex++, total);
    const fallback = fallbackSummaries.get(slideIndex) ?? "";
    const text = segment || fallback;
    const withTitle = text ? ensureSlideTitleLine({ text, slide, total: slideTotal }) : "";
    parts.push(withTitle ? `[slide:${slideIndex}]\n${withTitle}` : `[slide:${slideIndex}]`);
  }
  return parts.join("\n\n");
}

function distributeParagraphs(paragraphs: string[], index: number, total: number): string {
  const start = Math.round((index * paragraphs.length) / total);
  const end = Math.round(((index + 1) * paragraphs.length) / total);
  return (
    paragraphs.slice(start, end).join("\n\n").trim() ||
    paragraphs[
      Math.min(paragraphs.length - 1, Math.floor((index * paragraphs.length) / total))
    ]?.trim() ||
    ""
  );
}
