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

  it("preserves explicit trailing delimiter ellipses from slide output", () => {
    const slides = [{ index: 1, timestamp: 4 }];
    const coerced = coerceSummaryWithSlides({
      markdown: "[slide:1]\nLife comes from you, not at you... ",
      slides,
      transcriptTimedText: null,
      lengthArg: { kind: "preset", preset: "short" },
    });
    expect(coerced).toContain("[slide:1]\nLife comes from you, not at you...");
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

  it("fills title-only slide blocks with transcript fallback when available", () => {
    const slides = [
      { index: 1, timestamp: 10 },
      { index: 2, timestamp: 60 },
    ];
    const markdown = [
      "Intro paragraph.",
      "",
      "[slide:1]",
      "Opening Title",
      "",
      "[slide:2]",
      "Second slide has full text.",
    ].join("\n");
    const coerced = coerceSummaryWithSlides({
      markdown,
      slides,
      transcriptTimedText: "[00:10] First fallback sentence.\n[01:00] Second fallback sentence.",
      lengthArg: { kind: "preset", preset: "short" },
    });
    expect(coerced).toContain("[slide:1]\nOpening Title\nFirst fallback sentence.");
    expect(coerced).toContain("[slide:2]\nSecond slide has full text.");
  });

  it("uses transcript fallback per slide instead of redistributing when markers are missing", () => {
    const slides = [
      { index: 1, timestamp: 10 },
      { index: 2, timestamp: 60 },
    ];
    const markdown = [
      "Intro paragraph.",
      "",
      "First freeform paragraph.",
      "",
      "Second freeform paragraph.",
    ].join("\n");
    const coerced = coerceSummaryWithSlides({
      markdown,
      slides,
      transcriptTimedText: "[00:10] First fallback sentence.\n[01:00] Second fallback sentence.",
      lengthArg: { kind: "preset", preset: "short" },
    });
    expect(coerced).toContain("[slide:1]");
    expect(coerced).toContain("First fallback sentence.");
    expect(coerced).toContain("[slide:2]\nSecond fallback sentence.");
    expect(coerced).not.toContain("[slide:1]\nFirst freeform paragraph.");
  });

  it("replaces obviously truncated slide bodies with transcript fallback", () => {
    const slides = [
      { index: 1, timestamp: 10 },
      { index: 2, timestamp: 20 },
    ];
    const markdown = [
      "[slide:1]",
      "This thought starts clearly but then keeps going...",
      "",
      "[slide:2]",
      "Complete second slide sentence.",
    ].join("\n");
    const coerced = coerceSummaryWithSlides({
      markdown,
      slides,
      transcriptTimedText: "[00:10] First fallback sentence.\n[00:20] Second fallback sentence.",
      lengthArg: { kind: "preset", preset: "short" },
    });
    expect(coerced).toContain("[slide:1]");
    expect(coerced).toContain("First fallback sentence.");
    expect(coerced).toContain("[slide:2]\nComplete second slide sentence.");
  });

  it("replaces mid-sentence slide truncation when fallback has richer coverage", () => {
    const slides = [
      { index: 1, timestamp: 10 },
      { index: 2, timestamp: 20 },
    ];
    const markdown = [
      "[slide:1]",
      "Real manifestation means training your mind and building the belief that you can act consistently and keep believing you",
      "",
      "[slide:2]",
      "Complete second slide sentence.",
    ].join("\n");
    const coerced = coerceSummaryWithSlides({
      markdown,
      slides,
      transcriptTimedText:
        "[00:10] Real manifestation means building belief through repeated action and disciplined follow-through until success compounds.\n[00:20] Second fallback sentence.",
      lengthArg: { kind: "preset", preset: "short" },
    });
    expect(coerced).toContain(
      "[slide:1]\nReal manifestation means building belief through repeated action",
    );
    expect(coerced).toContain("[slide:2]\nComplete second slide sentence.");
  });

  it("does not inject very long transcript fallback blobs into truncated slide summaries", () => {
    const slides = [
      { index: 1, timestamp: 10 },
      { index: 2, timestamp: 20 },
    ];
    const markdown = [
      "[slide:1]",
      "The creator closes with a warning about hardware demand and claims this window is your last chance to secure local AI before it",
      "",
      "[slide:2]",
      "Second slide stays concise.",
    ].join("\n");
    const longFallback = Array.from({ length: 180 }, (_, i) => `word${i + 1}`).join(" ");
    const coerced = coerceSummaryWithSlides({
      markdown,
      slides,
      transcriptTimedText: `[00:10] ${longFallback}\n[00:20] Short fallback second.`,
      lengthArg: { kind: "preset", preset: "short" },
    });
    expect(coerced).toContain(
      "The creator closes with a warning about hardware demand and claims this window is your last chance",
    );
    expect(coerced).not.toContain("word120 word121 word122");
    expect(coerced).toContain("[slide:2]\nSecond slide stays concise.");
  });

  it("compacts oversized slide blocks into sentence-complete summaries", () => {
    const slides = [
      { index: 1, timestamp: 1 },
      { index: 2, timestamp: 2 },
    ];
    const oversized = Array.from(
      { length: 80 },
      (_, i) => `Sentence ${i + 1} explains the same point in a repetitive way.`,
    ).join(" ");
    const coerced = coerceSummaryWithSlides({
      markdown: ["[slide:1]", oversized, "", "[slide:2]", "Second concise slide."].join("\n"),
      slides,
      transcriptTimedText: null,
      lengthArg: { kind: "preset", preset: "short" },
    });
    expect(coerced).toContain("[slide:1]");
    expect(coerced).not.toContain("Sentence 40 explains the same point");
    expect(coerced).toContain("Sentence 1 explains the same point");
    expect(coerced).toContain("[slide:2]\nSecond concise slide.");
  });

  it("does not replace truncated summaries with transcript-like fallback dialog", () => {
    const slides = [
      { index: 1, timestamp: 10 },
      { index: 2, timestamp: 20 },
    ];
    const markdown = [
      "[slide:1]",
      "This section starts as a concise recap but then trails off before it",
      "",
      "[slide:2]",
      "Second slide remains concise.",
    ].join("\n");
    const transcriptLikeFallback =
      "And I started at the A's and read through all the way through the Z's. >> Thank you, Tom. >> Would you like to see a better world?";
    const coerced = coerceSummaryWithSlides({
      markdown,
      slides,
      transcriptTimedText: `[00:10] ${transcriptLikeFallback}\n[00:20] Another fallback line.`,
      lengthArg: { kind: "preset", preset: "short" },
    });
    expect(coerced).not.toContain(">> Thank you, Tom");
    expect(coerced).not.toContain("Would you like to see a better world");
    expect(coerced).toContain("[slide:2]\nSecond slide remains concise.");
  });

  it("rewrites transcript-like direct speech into neutral slide prose", () => {
    const slides = [{ index: 1, timestamp: 1 }];
    const markdown = [
      "[slide:1]",
      "I'm going to show you everything I built and then we test a new model. >> Thank you, Tom. Would you like to subscribe?",
    ].join("\n");
    const coerced = coerceSummaryWithSlides({
      markdown,
      slides,
      transcriptTimedText: null,
      lengthArg: { kind: "preset", preset: "short" },
    });
    expect(coerced).toContain("[slide:1]");
    expect(coerced).toContain("The speaker");
    expect(coerced).not.toContain("The speaker The speaker");
    expect(coerced).not.toContain(">>");
    expect(coerced).not.toContain("Would you like to subscribe");
    expect(coerced).not.toContain("I'm going to");
  });

  it("rewrites conversational tails like 'right?' and 'in a way of like'", () => {
    const slides = [{ index: 1, timestamp: 1 }];
    const markdown = [
      "[slide:1]",
      "Even like the stoics talked about this Marcus Aurelius, right? So he meant it more in a way of like if you think positively you'll have a positive life.",
    ].join("\n");
    const coerced = coerceSummaryWithSlides({
      markdown,
      slides,
      transcriptTimedText: null,
      lengthArg: { kind: "preset", preset: "short" },
    });
    expect(coerced).toContain("[slide:1]");
    expect(coerced).not.toContain("Even like");
    expect(coerced).not.toContain("right?");
    expect(coerced).not.toContain("in a way of like");
  });

  it("strips leading disfluencies from titled bullet slide text", () => {
    const slides = [{ index: 1, timestamp: 1 }];
    const markdown = [
      "[slide:1]",
      "Future Plans and Societal Impact",
      "- Um, but this, this inherent problem that MCPs by default clutter up context. Playwright remains an acceptable exception.",
    ].join("\n");
    const coerced = coerceSummaryWithSlides({
      markdown,
      slides,
      transcriptTimedText: null,
      lengthArg: { kind: "preset", preset: "short" },
    });
    expect(coerced).toContain("[slide:1]\nFuture Plans and Societal Impact");
    expect(coerced).not.toContain("\n- Um");
    expect(coerced).not.toContain("\nUm,");
    expect(coerced).not.toContain("this, this");
  });

  it("normalizes awkward pronoun-conjugation artifacts in transcript-like tails", () => {
    const slides = [{ index: 1, timestamp: 1 }];
    const markdown = [
      "[slide:1]",
      "- Um, how it works internally for me is I will put it exactly how it is, you know. I'm an artist. Every day, I am painting Mona Lisa, right?",
    ].join("\n");
    const coerced = coerceSummaryWithSlides({
      markdown,
      slides,
      transcriptTimedText: null,
      lengthArg: { kind: "preset", preset: "short" },
    });
    expect(coerced).toContain("[slide:1]");
    expect(coerced).not.toContain("The speaker are");
    expect(coerced).not.toContain("for them is they");
    expect(coerced).not.toContain("they am");
    expect(coerced).not.toContain(", .");
    expect(coerced).toContain("Internally, the speaker will put it exactly how it is.");
  });

  it("rewrites corrupted run-on slide tails with stutter/contraction artifacts", () => {
    const slides = [{ index: 1, timestamp: 1 }];
    const markdown = [
      "[slide:1]",
      "Men in their 40s let's say who he works with and they said what he notices there's this really common that he sees sense of a lack of purpose around that age and how can people go about finding that and had they recorded any conversations about this and they have they have recorded some where it talks about on the okay they want to find a purpose in their job or whatever but it's it seems to them that then the real purpose can't be find found on that level, the real purpose is to awake to their true nature, to the fact that and the implications of their true nature, the implications that, they are people're them, things aren't real.",
    ].join("\n");
    const coerced = coerceSummaryWithSlides({
      markdown,
      slides,
      transcriptTimedText:
        "[00:01] The discussion focuses on people in midlife who feel a lack of purpose and asks how they can find meaning through direct inner work instead of external status.",
      lengthArg: { kind: "preset", preset: "xxl" },
    });
    expect(coerced).toContain("[slide:1]");
    expect(coerced).not.toContain("people're");
    expect(coerced).not.toContain("they have they have");
    expect(coerced).not.toContain("let's say");
    expect(coerced).not.toContain("to the fact that and the implications");
    expect(coerced).toContain("lack of purpose");
  });

  it("avoids malformed rewritten starts and keeps richer corrupted-tail content", () => {
    const slides = [{ index: 1, timestamp: 1 }];
    const markdown = [
      "[slide:1]",
      "It is it seems to them that, the real purpose can't be find found on that level, the real purpose is to awake to their true nature, to the fact that and the implications of their true nature, and they better start acting in accordance with that, otherwise people get to their deathbed and people're like, \"Oh, well, that was a complete waste of time.",
    ].join("\n");
    const coerced = coerceSummaryWithSlides({
      markdown,
      slides,
      transcriptTimedText: null,
      lengthArg: { kind: "preset", preset: "xxl" },
    });
    expect(coerced).not.toContain("It is it seems");
    expect(coerced).not.toContain("The speaker better");
    expect(coerced).not.toContain("people're");
    expect(coerced).not.toContain("people are like.");
    expect(coerced.length).toBeGreaterThan(180);
  });

  it("replaces low-quality final slide text with cleaned transcript fallback when available", () => {
    const slides = [{ index: 1, timestamp: 1 }];
    const markdown = [
      "[slide:1]",
      "Implications for Living and Purpose",
      "It is it seems to them that, the real purpose can't be find found on that level, the real purpose is to awake to their true nature, to the fact that and the implications of their true nature, and they better start acting in accordance with that, otherwise people get to their deathbed and people're like, \"Oh, well, that was a complete waste of time.",
    ].join("\n");
    const transcriptTimedText =
      "[00:01] The speaker says many people in midlife feel a lack of purpose when they only chase external goals. [00:30] Real purpose comes from awakening to one's true nature and acting in alignment with that understanding. [00:58] Otherwise people risk reaching the end of life feeling they spent their time on the wrong things.";
    const coerced = coerceSummaryWithSlides({
      markdown,
      slides,
      transcriptTimedText,
      lengthArg: { kind: "preset", preset: "xxl" },
    });
    expect(coerced).toContain("[slide:1]\nImplications for Living and Purpose");
    expect(coerced).toContain("lack of purpose");
    expect(coerced).not.toContain("people're");
    expect(coerced).not.toContain("It is it seems");
    expect(coerced).not.toContain("to the fact that and the implications");
  });

  it("drops fragmented q-and-a transcript fragments in final slide prose", () => {
    const slides = [{ index: 1, timestamp: 1 }];
    const markdown = [
      "[slide:1]",
      "How can people go about finding that. Had they recorded any conversations about this. They have they have recorded some where it talks about on the okay they want to find a purpose in their job or whatever. It seems to them that. The real purpose cannot be found on that level. The real purpose is to awaken to their true nature. They should start acting in accordance with that. Otherwise, as people say, people get to their deathbed and people are like, Oh, well, that was a complete waste of time.",
    ].join("\n");
    const coerced = coerceSummaryWithSlides({
      markdown,
      slides,
      transcriptTimedText: null,
      lengthArg: { kind: "preset", preset: "xxl" },
    });
    expect(coerced).not.toContain("How can people go about finding that.");
    expect(coerced).not.toContain("Had they recorded any conversations about this.");
    expect(coerced).not.toContain("they have they have");
    expect(coerced).toContain("The real purpose cannot be found on that level.");
  });

  it("strips transcript stage-direction tags and avoids 'people' pronoun rewrites", () => {
    const slides = [{ index: 1, timestamp: 1 }];
    const markdown = ["[slide:1]", "This is when the wound [music] becomes a scar. You notice peace."].join(
      "\n",
    );
    const coerced = coerceSummaryWithSlides({
      markdown,
      slides,
      transcriptTimedText: null,
      lengthArg: { kind: "preset", preset: "xxl" },
    });
    expect(coerced).not.toContain("[music]");
    expect(coerced).not.toContain("people notice");
  });

  it("does not replace long bodies solely for ending mid-sentence", () => {
    const slides = [
      { index: 1, timestamp: 10 },
      { index: 2, timestamp: 20 },
    ];
    const longBody =
      "Identity ultimately drives behavior and this section intentionally runs long with many details from the speaker about school discipline grades confidence and repeated effort over time so that it exceeds the truncation-heuristic word window and should not be replaced by transcript fallback even if it does not end with punctuation";
    const markdown = [`[slide:1]`, longBody, "", "[slide:2]", "Second slide body."].join("\n");
    const coerced = coerceSummaryWithSlides({
      markdown,
      slides,
      transcriptTimedText: "[00:10] First fallback sentence.\n[00:20] Second fallback sentence.",
      lengthArg: { kind: "preset", preset: "short" },
    });
    expect(coerced).toContain("Identity ultimately drives behavior");
    expect(coerced).not.toContain("[slide:1]\nFirst fallback sentence.");
  });

  it("redistributes collapsed trailing body across all slide markers", () => {
    const slides = [
      { index: 1, timestamp: 10 },
      { index: 2, timestamp: 20 },
      { index: 3, timestamp: 30 },
    ];
    const markdown = [
      "[slide:1]",
      "Title One",
      "",
      "[slide:2]",
      "Title Two",
      "",
      "[slide:3]",
      "Title Three",
      "",
      "Sentence one. Sentence two. Sentence three.",
    ].join("\n");
    const coerced = coerceSummaryWithSlides({
      markdown,
      slides,
      transcriptTimedText: null,
      lengthArg: { kind: "preset", preset: "short" },
    });
    expect(coerced).toContain("[slide:1]\nSentence one.");
    expect(coerced).toContain("[slide:2]\nSentence two.");
    expect(coerced).toContain("[slide:3]\nSentence three.");
  });

  it("redistributes tail body when the last marker absorbs all narrative text", () => {
    const slides = [
      { index: 1, timestamp: 10 },
      { index: 2, timestamp: 20 },
      { index: 3, timestamp: 30 },
    ];
    const markdown = [
      "[slide:1] Title One",
      "[slide:2] Title Two",
      "[slide:3] Title Three",
      "Sentence one. Sentence two. Sentence three.",
    ].join("\n");
    const coerced = coerceSummaryWithSlides({
      markdown,
      slides,
      transcriptTimedText: null,
      lengthArg: { kind: "preset", preset: "short" },
    });
    expect(coerced).toContain("[slide:1]\nTitle One\nSentence one.");
    expect(coerced).toContain("[slide:2]\nTitle Two\nSentence two.");
    expect(coerced).toContain("[slide:3]\nTitle Three\nSentence three.");
  });

  it("fills collapsed tail blobs from transcript fallback when coverage exists", () => {
    const slides = [
      { index: 1, timestamp: 10 },
      { index: 2, timestamp: 20 },
      { index: 3, timestamp: 30 },
    ];
    const markdown = [
      "[slide:1] Title One",
      "[slide:2] Title Two",
      "[slide:3] Title Three",
      "one two three four five six seven eight nine ten eleven twelve",
    ].join("\n");
    const coerced = coerceSummaryWithSlides({
      markdown,
      slides,
      transcriptTimedText: "[00:10] Fallback one.\n[00:20] Fallback two.\n[00:30] Fallback three.",
      lengthArg: { kind: "preset", preset: "short" },
    });
    expect(coerced).toContain("[slide:1]\nTitle One\nFallback one.");
    expect(coerced).toContain("[slide:2]\nTitle Two\nFallback two.");
    expect(coerced).toContain("[slide:3]\nTitle Three\nFallback three.");
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
    expect(text).toBe("world");
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
    const boundedNotTruncated = getTranscriptTextForSlide({
      slide: { index: 1, timestamp: 1 },
      nextSlide: { index: 2, timestamp: 30 },
      segments: longSegments,
      budget: 20,
      windowSeconds: 10,
    });
    expect(boundedNotTruncated.endsWith("...")).toBe(false);
    expect(boundedNotTruncated).toContain("consectetur adipiscing elit");

    const finalSlideText = getTranscriptTextForSlide({
      slide: { index: 1, timestamp: 1 },
      nextSlide: null,
      segments: longSegments,
      budget: 20,
      windowSeconds: 10,
    });
    expect(finalSlideText.endsWith("...")).toBe(false);
    expect(finalSlideText).toContain("consectetur adipiscing elit");
  });

  it("backfills prior transcript context when a slide starts mid-sentence", () => {
    const segments = [
      { startSeconds: 362, text: "Belief drives behavior." },
      { startSeconds: 366, text: "about this Marcus Aurelius, right? He" },
      { startSeconds: 369, text: "wrote about how your thoughts pretty" },
      { startSeconds: 370, text: "much determine your experience of life." },
    ];
    const text = getTranscriptTextForSlide({
      slide: { index: 6, timestamp: 399 },
      nextSlide: null,
      segments,
      budget: 500,
      windowSeconds: 120,
    });
    expect(text.startsWith("wrote about how your thoughts")).toBe(false);
    expect(text.startsWith("He wrote about how your thoughts pretty")).toBe(true);
    expect(text).toContain("wrote about how your thoughts pretty much determine your experience of life.");
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
