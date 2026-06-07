import { describe, expect, it } from "vitest";
import {
  buildSlideTextFallback,
  buildTimestampUrl,
  coerceSummaryWithSlides,
  extractSlideMarkers,
  findSlidesSectionStart,
  formatOsc8Link,
  formatTimestamp,
  getTranscriptTextForSlide,
  interleaveSlidesIntoTranscript,
  parseSlideSummariesFromMarkdown,
  parseTranscriptTimedText,
  resolveSlideTextBudget,
  resolveSlideWindowSeconds,
  splitSlideTitleFromText,
  splitSummaryFromSlides,
} from "../src/run/flows/url/slides-text.js";

describe("slides text helpers", () => {
  it("finds the earliest slides marker", () => {
    const markdown = ["# Title", "", "[slide:2] Second", "", "### Slides", "[slide:1] First"].join(
      "\n",
    );
    expect(findSlidesSectionStart(markdown)).toBe(markdown.indexOf("[slide:2]"));
  });

  it("returns null when no slides section exists", () => {
    expect(findSlidesSectionStart("Just text.")).toBeNull();
  });

  it("splits summary from slides section", () => {
    const markdown = ["Intro line", "", "### Slides", "[slide:1] Hello"].join("\n");
    expect(splitSummaryFromSlides(markdown)).toEqual({
      summary: "Intro line",
      slidesSection: "### Slides\n[slide:1] Hello",
    });
    expect(splitSummaryFromSlides("Only summary").slidesSection).toBeNull();
  });

  it("finds slides section from slide labels", () => {
    const markdown = ["Intro", "", "Slide 1 \u00b7 0:01", "Text"].join("\n");
    expect(findSlidesSectionStart(markdown)).not.toBeNull();
  });

  it("parses slide summaries and ignores invalid entries", () => {
    const markdown = [
      "### Slides",
      "[slide:0] ignored",
      "[slide:1] First line",
      "continued line",
      "",
      "[slide:2] Second line",
      "",
      "## Next",
      "ignored content",
    ].join("\n");
    const result = parseSlideSummariesFromMarkdown(markdown);
    expect(result.get(1)).toBe("First line\ncontinued line");
    expect(result.get(2)).toBe("Second line");
    expect(result.has(0)).toBe(false);
  });

  it("keeps empty slide markers from swallowing later markdown sections", () => {
    const markdown = ["Intro", "", "### Slides", "[slide:1]", "", "### Sources", "Other"].join(
      "\n",
    );
    const result = parseSlideSummariesFromMarkdown(markdown);
    expect(result.get(1)).toBe("");
    expect(result.size).toBe(1);

    const compact = ["### Slides", "[slide:1]", "### Sources", "Other"].join("\n");
    expect(parseSlideSummariesFromMarkdown(compact).get(1)).toBe("");
  });

  it("extracts slide markers from inline tags", () => {
    const markers = extractSlideMarkers("[slide:1]\nText\n[slide:2] More");
    expect(markers).toEqual([1, 2]);
  });

  it("builds slide text fallback from transcript", () => {
    const fallback = buildSlideTextFallback({
      slides: [
        { index: 1, timestamp: 5 },
        { index: 2, timestamp: 12 },
      ],
      transcriptTimedText: "[00:05] Hello there\n[00:10] General Kenobi",
      lengthArg: { kind: "preset", preset: "short" },
    });
    expect(fallback.get(1)).toContain("Hello");
    expect(fallback.size).toBeGreaterThan(0);
    expect(
      buildSlideTextFallback({
        slides: [{ index: 1, timestamp: 5 }],
        transcriptTimedText: "",
        lengthArg: { kind: "preset", preset: "short" },
      }).size,
    ).toBe(0);
  });

  it("ignores malformed transcript timestamps for slide fallbacks", () => {
    const segments = parseTranscriptTimedText("[00:05] Valid\n[00:60] Invalid\n[1:60:00] Bad");
    expect(segments).toEqual([{ startSeconds: 5, text: "Valid" }]);

    expect(
      interleaveSlidesIntoTranscript({
        transcriptTimedText: "[00:60] Invalid\n[00:05] Valid",
        slides: [{ index: 1, timestamp: 10 }],
      }),
    ).toBe("[00:60] Invalid\n[00:05] Valid\n[slide:1]");
  });

  it("coerces summaries without markers into slide blocks", () => {
    const markdown = [
      "### Intro",
      "Short intro sentence. Another sentence.",
      "",
      "### Slides",
      "Slide 1 \u00b7 0:01",
      "First slide text.",
      "",
      "Slide 2 \u00b7 0:02",
      "Second slide text.",
    ].join("\n");
    const coerced = coerceSummaryWithSlides({
      markdown,
      slides: [
        { index: 1, timestamp: 1 },
        { index: 2, timestamp: 2 },
      ],
      transcriptTimedText: null,
      lengthArg: { kind: "preset", preset: "short" },
    });
    expect(coerced).toContain("[slide:1]");
    expect(coerced).toContain("[slide:2]");
    expect(coerced).toContain("First slide text.");
    expect(coerced).toContain("Second slide text.");
  });

  it("reuses summary paragraphs instead of transcript filler when slides outnumber paragraphs", () => {
    const coerced = coerceSummaryWithSlides({
      markdown: [
        "The first summary paragraph explains the setup.",
        "",
        "The second summary paragraph explains the conflict.",
        "",
        "The third summary paragraph explains the resolution.",
      ].join("\n"),
      slides: [
        { index: 1, timestamp: 0 },
        { index: 2, timestamp: 60 },
        { index: 3, timestamp: 120 },
        { index: 4, timestamp: 180 },
        { index: 5, timestamp: 240 },
        { index: 6, timestamp: 300 },
      ],
      transcriptTimedText:
        "[00:00] raw transcript one\n[01:00] raw transcript two\n[02:00] raw transcript three",
      lengthArg: { kind: "preset", preset: "short" },
      reserveIntro: false,
    });

    expect(coerced).not.toContain("raw transcript");
    expect(coerced).toContain("[slide:2]\nThe first summary paragraph explains the setup.");
    expect(coerced).toContain("[slide:4]\nThe second summary paragraph explains the conflict.");
    expect(coerced).toContain("[slide:6]\nThe third summary paragraph explains the resolution.");
  });

  it("does not invent slide title lines", () => {
    const slides = [{ index: 1, timestamp: 4 }];
    const coerced = coerceSummaryWithSlides({
      markdown: "Intro\n\n[slide:1]\nThis segment explains the setup.",
      slides,
      transcriptTimedText: null,
      lengthArg: { kind: "preset", preset: "short" },
    });
    expect(coerced).not.toContain("Title:");
    expect(coerced).toContain("This segment explains the setup.");
  });

  it("detects markdown heading lines as slide titles", () => {
    const parsed = splitSlideTitleFromText({
      text: "## Graphene breakthroughs\nGraphene is strong and conductive.",
      slideIndex: 1,
      total: 3,
    });
    expect(parsed.title).toBe("Graphene breakthroughs");
    expect(parsed.body).toContain("Graphene is strong and conductive.");

    const sentence = splitSlideTitleFromText({
      text: "Graphene is strong and conductive.\nMore details.",
      slideIndex: 1,
      total: 3,
    });
    expect(sentence.title).toBe("Graphene is strong and conductive");
  });

  it("treats Title labels as slide titles", () => {
    const parsed = splitSlideTitleFromText({
      text: "Title: Graphene breakthroughs\nGraphene is strong and conductive.",
      slideIndex: 1,
      total: 3,
    });
    expect(parsed.title).toBe("Graphene breakthroughs");
    expect(parsed.body).toBe("Graphene is strong and conductive.");
  });

  it("treats plain title lines as slide titles when followed by body", () => {
    const parsed = splitSlideTitleFromText({
      text: "Podcast Introduction\nThe hosts welcome each other.",
      slideIndex: 1,
      total: 3,
    });
    expect(parsed.title).toBe("Podcast Introduction");
    expect(parsed.body).toBe("The hosts welcome each other.");
  });

  it("ignores leading slide labels before titles", () => {
    const parsed = splitSlideTitleFromText({
      text: "Slide 1/10 · 0:02\nTitle: Podcast Introduction\nThe hosts welcome each other.",
      slideIndex: 1,
      total: 3,
    });
    expect(parsed.title).toBe("Podcast Introduction");
    expect(parsed.body).toBe("The hosts welcome each other.");
  });

  it("lifts later heading lines as titles", () => {
    const parsed = splitSlideTitleFromText({
      text: "First paragraph line.\n## Late title\nSecond paragraph line.",
      slideIndex: 1,
      total: 3,
    });
    expect(parsed.title).toBe("Late title");
    expect(parsed.body).toBe("First paragraph line.\nSecond paragraph line.");
  });

  it("uses the next line when a Title label is empty", () => {
    const parsed = splitSlideTitleFromText({
      text: "Title:\nGraphene breakthroughs\nGraphene is strong and conductive.",
      slideIndex: 1,
      total: 3,
    });
    expect(parsed.title).toBe("Graphene breakthroughs");
    expect(parsed.body).toBe("Graphene is strong and conductive.");
  });

  it("strips Title labels from markdown headings", () => {
    const parsed = splitSlideTitleFromText({
      text: "## Title: Graphene breakthroughs\nGraphene is strong and conductive.",
      slideIndex: 1,
      total: 3,
    });
    expect(parsed.title).toBe("Graphene breakthroughs");
    expect(parsed.body).toBe("Graphene is strong and conductive.");
  });

  it("uses the next line when a heading Title label is empty", () => {
    const parsed = splitSlideTitleFromText({
      text: "## Title:\nGraphene breakthroughs\nGraphene is strong and conductive.",
      slideIndex: 1,
      total: 3,
    });
    expect(parsed.title).toBe("Graphene breakthroughs");
    expect(parsed.body).toBe("Graphene is strong and conductive.");
  });

  it("coerces summaries with markers and missing slides", () => {
    const slides = [
      { index: 1, timestamp: 10 },
      { index: 2, timestamp: 20 },
    ];
    const coerced = coerceSummaryWithSlides({
      markdown: "Intro\n\n[slide:1]\nText",
      slides,
      transcriptTimedText: null,
      lengthArg: { kind: "preset", preset: "short" },
    });
    expect(coerced).toContain("[slide:1]");
    expect(coerced).toContain("Intro");

    const withSummaries = coerceSummaryWithSlides({
      markdown: "### Slides\n[slide:1] First",
      slides,
      transcriptTimedText: "[00:20] Second fallback",
      lengthArg: { kind: "preset", preset: "short" },
    });
    expect(withSummaries).toContain("[slide:2]");

    const onlyIntro = coerceSummaryWithSlides({
      markdown: "Just an intro.",
      slides,
      transcriptTimedText: null,
      lengthArg: { kind: "preset", preset: "short" },
    });
    expect(onlyIntro).toContain("[slide:1]");
  });

  it("does not backfill empty slide markers", () => {
    const slides = [
      { index: 1, timestamp: 10 },
      { index: 2, timestamp: 20 },
    ];
    const coerced = coerceSummaryWithSlides({
      markdown: "Intro\n\n[slide:1]\n\n[slide:2] Covered segment.",
      slides,
      transcriptTimedText: "[00:10] FALLBACK SEGMENT\n[00:20] Another segment",
      lengthArg: { kind: "preset", preset: "short" },
    });
    expect(coerced).toContain("[slide:1]");
    expect(coerced).not.toContain("FALLBACK SEGMENT");
    expect(coerced).toContain("Covered segment.");
  });

  it("redistributes text when slides only have titles", () => {
    const slides = [
      { index: 1, timestamp: 10 },
      { index: 2, timestamp: 20 },
    ];
    const markdown = [
      "Intro paragraph.",
      "",
      "[slide:1]",
      "Welcome and Updates",
      "",
      "[slide:2]",
      "Security Nightmare",
      "",
      "First body paragraph.",
      "",
      "Second body paragraph.",
    ].join("\n");
    const coerced = coerceSummaryWithSlides({
      markdown,
      slides,
      transcriptTimedText: null,
      lengthArg: { kind: "preset", preset: "short" },
    });
    expect(coerced).toContain("[slide:1]\nFirst body paragraph.");
    expect(coerced).toContain("[slide:2]\nSecond body paragraph.");
  });

  it("preserves interlude headings for sponsor-only slide blocks", () => {
    const slides = [
      { index: 1, timestamp: 10 },
      { index: 2, timestamp: 20 },
    ];
    const coerced = coerceSummaryWithSlides({
      markdown: ["[slide:1]", "## Interlude", "", "[slide:2]", "## Interlude"].join("\n"),
      slides,
      transcriptTimedText: null,
      lengthArg: { kind: "preset", preset: "short" },
    });

    expect(coerced).toContain("[slide:1]\n## Interlude");
    expect(coerced).toContain("[slide:2]\n## Interlude");
  });

  it("preserves body text after a final markdown slide heading", () => {
    const slides = [{ index: 1, timestamp: 10 }];
    const markdown = ["[slide:1]", "## Key Topic", "", "This is the body paragraph."].join("\n");
    const coerced = coerceSummaryWithSlides({
      markdown,
      slides,
      transcriptTimedText: null,
      lengthArg: { kind: "preset", preset: "short" },
    });

    expect(coerced).toContain("[slide:1]\n## Key Topic");
    expect(coerced).toContain("This is the body paragraph.");
  });

  it("does not redistribute stray text into all-interlude slides", () => {
    const slides = [
      { index: 1, timestamp: 10 },
      { index: 2, timestamp: 20 },
    ];
    const markdown = [
      "Intro paragraph.",
      "",
      "[slide:1]",
      "## Interlude",
      "",
      "[slide:2]",
      "## Interlude",
      "",
      "Stray sponsor takeaway.",
    ].join("\n");
    const coerced = coerceSummaryWithSlides({
      markdown,
      slides,
      transcriptTimedText: null,
      lengthArg: { kind: "preset", preset: "short" },
    });

    expect(coerced).toContain("[slide:1]\n## Interlude");
    expect(coerced).toContain("[slide:2]\n## Interlude");
    expect(coerced).not.toContain("Stray sponsor takeaway.");
  });

  it("does not treat missing slide indexes as all-interlude", () => {
    const slides = [
      { index: 1, timestamp: 10 },
      { index: 2, timestamp: 20 },
    ];
    const markdown = [
      "Intro paragraph.",
      "",
      "[slide:1]",
      "## Interlude",
      "",
      "[slide:3]",
      "## Interlude",
    ].join("\n");
    const coerced = coerceSummaryWithSlides({
      markdown,
      slides,
      transcriptTimedText: "[00:20] Missing slide body.",
      lengthArg: { kind: "preset", preset: "short" },
    });

    expect(coerced).toContain("[slide:1]\n## Interlude");
    expect(coerced).toContain("[slide:2]");
    expect(coerced).toContain("Missing slide body.");
  });

  it("does not promote stray all-interlude text when there is no intro", () => {
    const slides = [
      { index: 1, timestamp: 10 },
      { index: 2, timestamp: 20 },
    ];
    const markdown = [
      "[slide:1]",
      "## Interlude",
      "",
      "[slide:2]",
      "## Interlude",
      "",
      "Stray sponsor takeaway.",
    ].join("\n");
    const coerced = coerceSummaryWithSlides({
      markdown,
      slides,
      transcriptTimedText: null,
      lengthArg: { kind: "preset", preset: "short" },
    });

    expect(coerced).toContain("[slide:1]\n## Interlude");
    expect(coerced).toContain("[slide:2]\n## Interlude");
    expect(coerced).not.toContain("Stray sponsor takeaway.");
    expect(coerced).not.toMatch(/^Stray/m);
  });

  it("keeps body text when one title-only slide is an interlude", () => {
    const slides = [
      { index: 1, timestamp: 10 },
      { index: 2, timestamp: 20 },
    ];
    const markdown = [
      "Intro paragraph.",
      "",
      "[slide:1]",
      "## Interlude",
      "",
      "[slide:2]",
      "Security Nightmare",
      "",
      "First body paragraph.",
      "",
      "Second body paragraph.",
    ].join("\n");
    const coerced = coerceSummaryWithSlides({
      markdown,
      slides,
      transcriptTimedText: null,
      lengthArg: { kind: "preset", preset: "short" },
    });

    expect(coerced).toContain("[slide:1]\n## Interlude");
    expect(coerced).toContain("[slide:2]");
    expect(coerced).toContain("First body paragraph.");
    expect(coerced).toContain("Second body paragraph.");
  });

  it("keeps mixed interlude markers when partial slide summaries are present", () => {
    const slides = [
      { index: 1, timestamp: 10 },
      { index: 2, timestamp: 20 },
    ];
    const markdown = ["[slide:1]", "Normal slide body.", "", "[slide:2]", "## Interlude"].join(
      "\n",
    );
    const coerced = coerceSummaryWithSlides({
      markdown,
      slides,
      transcriptTimedText: "[00:20] transcript fallback should not replace the interlude",
      lengthArg: { kind: "preset", preset: "short" },
    });

    expect(coerced).toContain("[slide:1]\nNormal slide body.");
    expect(coerced).toContain("[slide:2]\n## Interlude");
    expect(coerced).not.toContain("[slide:2]\n[slide:2]");
  });

  it("fills missing partial slide sections from summary paragraphs", () => {
    const slides = Array.from({ length: 6 }, (_, index) => ({
      index: index + 1,
      timestamp: index * 60,
    }));
    const markdown = [
      "Paragraph one summary.",
      "",
      "Paragraph two summary.",
      "",
      "Paragraph three summary.",
      "",
      "### Slides",
      "[slide:1]",
      "Direct slide one.",
      "",
      "[slide:2]",
      "Direct slide two.",
      "",
      "[slide:3]",
      "Direct slide three.",
      "",
      "[slide:4]",
      "Direct slide four.",
      "",
      "[slide:5]",
      "Direct slide five.",
      "",
      "[slide:6]",
    ].join("\n");
    const coerced = coerceSummaryWithSlides({
      markdown,
      slides,
      transcriptTimedText: "[05:00] raw transcript that should not be used",
      lengthArg: { kind: "preset", preset: "short" },
      reserveIntro: false,
    });

    expect(coerced).toContain("[slide:6]\nParagraph three summary.");
    expect(coerced).not.toContain("raw transcript");
  });

  it("replaces title-only partial slide sections with summary paragraphs", () => {
    const slides = Array.from({ length: 6 }, (_, index) => ({
      index: index + 1,
      timestamp: index * 60,
    }));
    const markdown = [
      "Paragraph one summary.",
      "",
      "Paragraph two summary.",
      "",
      "Paragraph three summary.",
      "",
      "### Slides",
      "[slide:1]",
      "Direct slide one.",
      "",
      "[slide:2]",
      "Direct slide two.",
      "",
      "[slide:3]",
      "Direct slide three.",
      "",
      "[slide:4]",
      "Direct slide four.",
      "",
      "[slide:5]",
      "Direct slide five.",
      "",
      "[slide:6]",
      "Slide 6/6 · 5:17",
    ].join("\n");
    const coerced = coerceSummaryWithSlides({
      markdown,
      slides,
      transcriptTimedText: "[05:00] raw transcript that should not be used",
      lengthArg: { kind: "preset", preset: "short" },
      reserveIntro: false,
    });

    expect(coerced).toContain("[slide:6]\nParagraph three summary.");
    expect(coerced).not.toContain("raw transcript");
    expect(coerced).not.toContain("Slide 6/6 · 5:17");
  });

  it("parses transcript timed text and sorts by timestamp", () => {
    const input = [
      "[00:10] Second",
      "bad line",
      "[00:05] First",
      "[00:05] ",
      "[00:aa] Nope",
      "[01:02:03] Hour mark",
    ].join("\n");
    const segments = parseTranscriptTimedText(input);
    expect(segments).toEqual([
      { startSeconds: 5, text: "First" },
      { startSeconds: 10, text: "Second" },
      { startSeconds: 3723, text: "Hour mark" },
    ]);
  });

  it("formats timestamps for minutes and hours", () => {
    expect(formatTimestamp(65)).toBe("1:05");
    expect(formatTimestamp(3661)).toBe("01:01:01");
  });

  it("resolves slide text budget with clamping", () => {
    expect(
      resolveSlideTextBudget({ lengthArg: { kind: "preset", preset: "short" }, slideCount: 2 }),
    ).toBe(120);
    expect(
      resolveSlideTextBudget({ lengthArg: { kind: "chars", maxCharacters: 50 }, slideCount: 1 }),
    ).toBe(80);
    expect(
      resolveSlideTextBudget({ lengthArg: { kind: "chars", maxCharacters: 20000 }, slideCount: 1 }),
    ).toBe(900);
  });

  it("resolves slide window seconds with clamping", () => {
    expect(resolveSlideWindowSeconds({ lengthArg: { kind: "preset", preset: "xl" } })).toBe(120);
    expect(resolveSlideWindowSeconds({ lengthArg: { kind: "chars", maxCharacters: 200 } })).toBe(
      30,
    );
    expect(resolveSlideWindowSeconds({ lengthArg: { kind: "chars", maxCharacters: 50000 } })).toBe(
      180,
    );
  });

  it("builds transcript text for a slide", () => {
    const segments = [
      { startSeconds: 2, text: "hello" },
      { startSeconds: 10, text: "world" },
      { startSeconds: 50, text: "later" },
    ];
    const text = getTranscriptTextForSlide({
      slide: { index: 1, timestamp: 8 },
      nextSlide: { index: 2, timestamp: 20 },
      segments,
      budget: 200,
      windowSeconds: 30,
    });
    expect(text).toBe("hello world");
    expect(
      getTranscriptTextForSlide({
        slide: { index: 1, timestamp: Number.NaN },
        nextSlide: null,
        segments,
        budget: 120,
        windowSeconds: 30,
      }),
    ).toBe("");
    expect(
      getTranscriptTextForSlide({
        slide: { index: 1, timestamp: 10 },
        nextSlide: null,
        segments: [],
        budget: 120,
        windowSeconds: 30,
      }),
    ).toBe("");
    expect(
      getTranscriptTextForSlide({
        slide: { index: 1, timestamp: 10 },
        nextSlide: null,
        segments,
        budget: 120,
        windowSeconds: -5,
      }),
    ).toBe("");

    const longSegments = [
      { startSeconds: 1, text: "lorem ipsum dolor sit amet" },
      { startSeconds: 2, text: "consectetur adipiscing elit" },
    ];
    const truncated = getTranscriptTextForSlide({
      slide: { index: 1, timestamp: 1 },
      nextSlide: null,
      segments: longSegments,
      budget: 20,
      windowSeconds: 10,
    });
    expect(truncated.endsWith("...")).toBe(true);
  });

  it("formats OSC-8 links when enabled", () => {
    expect(formatOsc8Link("Label", "https://example.com", false)).toBe("Label");
    expect(formatOsc8Link("Label", null, true)).toBe("Label");
    expect(formatOsc8Link("Label", "https://example.com", true)).toContain("https://example.com");
  });

  it("builds timestamp URLs for known hosts", () => {
    const youtubeId = "dQw4w9WgXcQ";
    expect(buildTimestampUrl(`https://www.youtube.com/watch?v=${youtubeId}`, 12)).toBe(
      `https://www.youtube.com/watch?v=${youtubeId}&t=12s`,
    );
    expect(buildTimestampUrl(`https://youtu.be/${youtubeId}`, 5)).toBe(
      `https://www.youtube.com/watch?v=${youtubeId}&t=5s`,
    );
    expect(buildTimestampUrl("https://vimeo.com/12345", 7)).toBe("https://vimeo.com/12345#t=7s");
    expect(buildTimestampUrl("https://loom.com/share/abc", 9)).toBe(
      "https://loom.com/share/abc?t=9",
    );
    expect(buildTimestampUrl("https://dropbox.com/s/abc/file.mp4", 11)).toBe(
      "https://dropbox.com/s/abc/file.mp4?t=11",
    );
    expect(buildTimestampUrl("not a url", 5)).toBeNull();
    expect(buildTimestampUrl("https://example.com/video", 5)).toBeNull();
  });

  it("interleaves slide markers into transcript", () => {
    const transcript = ["[00:05] Alpha", "[00:10] Beta"].join("\n");
    const interleaved = interleaveSlidesIntoTranscript({
      transcriptTimedText: transcript,
      slides: [
        { index: 1, timestamp: 3 },
        { index: 2, timestamp: 9 },
      ],
    });
    expect(interleaved).toContain("[slide:1]");
    expect(interleaved).toContain("[slide:2]");
    expect(interleaveSlidesIntoTranscript({ transcriptTimedText: "", slides: [] })).toBe("");
  });
});
