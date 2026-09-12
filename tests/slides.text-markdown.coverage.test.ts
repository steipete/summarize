import { describe, expect, it } from "vitest";
import {
  buildSlideTextFallback,
  coerceSummaryWithSlides,
} from "../packages/core/src/slides/text-compose.js";
import {
  ensureSlideTitleLine,
  extractSlideMarkers,
  findSlidesSectionStart,
  normalizeSummarySlideHeadings,
  parseSlideSummariesFromMarkdown,
  splitSlideTitleFromText,
  splitSummaryFromSlides,
} from "../packages/core/src/slides/text-markdown.js";

const slides = [
  { index: 1, timestamp: 0 },
  { index: 2, timestamp: 20 },
];

describe("slide markdown codec coverage", () => {
  it("covers empty, marker-only, labeled, heading, and derived titles", () => {
    expect(splitSlideTitleFromText({ text: "", slideIndex: 1, total: 1 })).toEqual({
      title: null,
      body: "",
    });
    expect(
      splitSlideTitleFromText({
        text: "Slide 1 of 1\n[slide:1]",
        slideIndex: 1,
        total: 1,
      }),
    ).toEqual({ title: null, body: "" });
    expect(
      splitSlideTitleFromText({
        text: "Title:\nFallback title\nBody sentence here.",
        slideIndex: 1,
        total: 1,
      }),
    ).toEqual({ title: "Fallback title", body: "Body sentence here." });
    expect(
      splitSlideTitleFromText({
        text: "## Title:\nHeading fallback\nBody sentence here.",
        slideIndex: 1,
        total: 1,
      }),
    ).toEqual({ title: "Heading fallback", body: "Body sentence here." });
    expect(
      splitSlideTitleFromText({
        text: "## Headline: Explicit heading\nBody.",
        slideIndex: 1,
        total: 1,
      }),
    ).toEqual({ title: "Explicit heading", body: "Body." });
    expect(
      splitSlideTitleFromText({
        text: "Only title\nThis is a complete body sentence.",
        slideIndex: 1,
        total: 1,
      }),
    ).toEqual({ title: "Only title", body: "This is a complete body sentence." });
    expect(
      splitSlideTitleFromText({
        text: "First title\nSecond title\nThis is a body sentence.",
        slideIndex: 1,
        total: 1,
      }),
    ).toEqual({ title: "First title", body: "Second title\nThis is a body sentence." });
    expect(
      splitSlideTitleFromText({
        text: "word",
        slideIndex: 1,
        total: 1,
      }),
    ).toEqual({ title: null, body: "word" });
    expect(
      splitSlideTitleFromText({
        text: "A useful headline clause, followed by more detail. Second sentence.",
        slideIndex: 1,
        total: 1,
      }),
    ).toMatchObject({ title: "A useful headline clause" });
    expect(
      ensureSlideTitleLine({
        text: "##Heading\n### Already spaced",
        slide: slides[0],
        total: 2,
      }),
    ).toBe("## Heading\n### Already spaced");
  });

  it("finds, splits, and parses every slide-section form", () => {
    expect(findSlidesSectionStart("")).toBeNull();
    expect(findSlidesSectionStart("plain")).toBeNull();
    expect(findSlidesSectionStart("Intro\n\n## Slides\n[slide:1]")).toBe(7);
    expect(findSlidesSectionStart("Intro\n\n[slide:1]")).toBe(7);
    expect(findSlidesSectionStart("Intro\n\nSlide 1 of 2 - title")).toBe(6);
    expect(splitSummaryFromSlides("  plain summary  ")).toEqual({
      summary: "plain summary",
      slidesSection: null,
    });

    expect(parseSlideSummariesFromMarkdown("")).toEqual(new Map());
    expect(parseSlideSummariesFromMarkdown("plain summary")).toEqual(new Map());
    expect(parseSlideSummariesFromMarkdown("prefix [slide:1]: first [slide:2] — second")).toEqual(
      new Map([
        [1, "first"],
        [2, "second"],
      ]),
    );
    expect(parseSlideSummariesFromMarkdown("prefix [slide:1]")).toEqual(new Map([[1, ""]]));
    expect(
      parseSlideSummariesFromMarkdown(
        [
          "### Slides",
          "[slide:0] ignored",
          "Slide 0",
          "[slide:1]",
          "",
          "Title only",
          "",
          "A body sentence that ends the slide section.",
          "",
          "## Appendix",
          "Ignored.",
        ].join("\n"),
      ),
    ).toEqual(new Map([[1, "Title only"]]));
  });

  it("extracts and normalizes malformed model slide headings", () => {
    expect(extractSlideMarkers(" ")).toEqual([]);
    expect(extractSlideMarkers("[slide:0] [custom slide marker 2] [slide:3]")).toEqual([2, 3]);
    expect(normalizeSummarySlideHeadings("")).toBe("");
    expect(normalizeSummarySlideHeadings("No markers")).toBe("No markers");

    const normalized = normalizeSummarySlideHeadings(
      [
        "# [slide:1] [00:01] # First title",
        "Slide 1 of 2",
        "Title: Replacement title",
        "Body.",
        "## [slide:2]",
        "",
        "Headline:",
        "Second body.",
      ].join("\n"),
    );
    expect(normalized).toBe(
      [
        "[slide:1]",
        "## First title",
        "Slide 1 of 2",
        "Title: Replacement title",
        "Body.",
        "[slide:2]",
        "",
        "Second body.",
      ].join("\n"),
    );
    expect(normalizeSummarySlideHeadings("[slide:1]\nSlide 1 of 2\nTitle: New title\nBody")).toBe(
      "[slide:1]\n## New title\nBody",
    );
    expect(normalizeSummarySlideHeadings("[slide:1]\nHeadline: New title\nBody")).toBe(
      "[slide:1]\n## New title\nBody",
    );
  });

  it("covers fallback early returns and character budgets", () => {
    expect(
      buildSlideTextFallback({
        slides,
        transcriptTimedText: null,
        lengthArg: { kind: "preset", preset: "short" },
      }),
    ).toEqual(new Map());
    expect(
      buildSlideTextFallback({
        slides: [],
        transcriptTimedText: "[00:00] text",
        lengthArg: { kind: "preset", preset: "short" },
      }),
    ).toEqual(new Map());
    expect(
      buildSlideTextFallback({
        slides,
        transcriptTimedText: "untimed text",
        lengthArg: { kind: "preset", preset: "short" },
      }),
    ).toEqual(new Map());
    expect(
      buildSlideTextFallback({
        slides: [...slides].reverse(),
        transcriptTimedText: "[00:00] first\n[00:20] second",
        lengthArg: { kind: "chars", maxCharacters: 200 },
      }),
    ).toEqual(
      new Map([
        [1, "first second"],
        [2, "second"],
      ]),
    );
  });

  it("coerces empty, title-only, interlude, fallback, and no-intro summaries", () => {
    expect(
      coerceSummaryWithSlides({
        markdown: "",
        slides,
        lengthArg: { kind: "preset", preset: "short" },
      }),
    ).toBe("");
    expect(
      coerceSummaryWithSlides({
        markdown: "Summary",
        slides: [],
        lengthArg: { kind: "preset", preset: "short" },
      }),
    ).toBe("Summary");

    expect(
      coerceSummaryWithSlides({
        markdown: "Intro.\n\n[slide:1]\nInterlude\n\n[slide:2]\n## Interlude",
        slides,
        lengthArg: { kind: "preset", preset: "short" },
      }),
    ).toBe("Intro.\n\n[slide:1]\n## Interlude\n\n[slide:2]\n## Interlude");

    const titleOnly = coerceSummaryWithSlides({
      markdown:
        "Intro.\n\nParagraph one.\n\nParagraph two.\n\n[slide:1]\nTitle one\n[slide:2]\nTitle two",
      slides,
      lengthArg: { kind: "preset", preset: "short" },
    });
    expect(titleOnly).toContain("[slide:1]\nParagraph one.");
    expect(titleOnly).toContain("[slide:2]\nParagraph two.");

    const fallback = coerceSummaryWithSlides({
      markdown: "Only intro.",
      slides,
      transcriptTimedText: "[00:00] first fallback\n[00:20] second fallback",
      lengthArg: { kind: "preset", preset: "short" },
    });
    expect(fallback).toContain("[slide:1]\nfirst fallback second fallback");
    expect(fallback).toContain("[slide:2]\nsecond fallback");

    const noIntro = coerceSummaryWithSlides({
      markdown: "Paragraph one.\n\nParagraph two.",
      slides,
      lengthArg: { kind: "preset", preset: "short" },
      reserveIntro: false,
    });
    expect(noIntro.startsWith("[slide:1]")).toBe(true);

    const partial = coerceSummaryWithSlides({
      markdown: "Intro.\n\nExtra paragraph.\n\n[slide:1]\n## Direct\nDirect body.",
      slides,
      transcriptTimedText: "[00:20] second fallback",
      lengthArg: { kind: "preset", preset: "short" },
    });
    expect(partial).toContain("[slide:1]\n## Direct\nDirect body.");
    expect(partial).toContain("[slide:2]\nExtra paragraph.");
  });
});
