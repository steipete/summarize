import { describe, expect, it } from "vitest";
import { createSlidesTextController } from "../apps/chrome-extension/src/entrypoints/sidepanel/slides-text-controller.js";

describe("sidepanel slides text controller", () => {
  it("builds transcript-first descriptions from timed text", () => {
    const slides = [
      { index: 1, timestamp: 0, imageUrl: "x", ocrText: "Ignored OCR text" },
      { index: 2, timestamp: 30, imageUrl: "y", ocrText: "Fallback OCR text for second slide" },
    ];
    const controller = createSlidesTextController({
      getSlides: () => slides,
      getLengthValue: () => "short",
      getSlidesOcrEnabled: () => true,
    });

    controller.setTranscriptTimedText(
      "[00:00] Intro text for the first slide.\n[00:30] Transcript text for the second slide.",
    );
    controller.syncTextState();

    expect(controller.getTranscriptAvailable()).toBe(true);
    expect(controller.getDescriptions().get(1)).toContain("Intro text");
    expect(controller.getDescriptions().get(2)).toContain("Transcript text");
  });

  it("keeps slides-derived titles authoritative over summary titles", () => {
    const controller = createSlidesTextController({
      getSlides: () => [{ index: 1, timestamp: 2, imageUrl: "x", ocrText: null }],
      getLengthValue: () => "short",
      getSlidesOcrEnabled: () => true,
    });

    expect(
      controller.updateSummaryFromMarkdown(
        ["### Slides", "Slide 1 · 0:02", "Canonical title", "Slide body text"].join("\n"),
        { source: "slides" },
      ),
    ).toBe(true);
    expect(controller.getTitles().get(1)).toBe("Canonical title");

    expect(
      controller.updateSummaryFromMarkdown(
        ["### Slides", "Slide 1 · 0:02", "Wrong title", "Other body text"].join("\n"),
        { source: "summary" },
      ),
    ).toBe(false);
    expect(controller.getTitles().get(1)).toBe("Canonical title");
  });

  it("keeps completed slide summaries authoritative over longer main summaries", () => {
    const controller = createSlidesTextController({
      getSlides: () => [{ index: 1, timestamp: 2, imageUrl: "x", ocrText: null }],
      getLengthValue: () => "short",
      getSlidesOcrEnabled: () => true,
    });

    expect(
      controller.updateSummaryFromMarkdown(
        ["[slide:1]", "## Canonical title", "Concise slide-specific body."].join("\n"),
        { source: "slides" },
      ),
    ).toBe(true);

    expect(
      controller.updateSummaryFromMarkdown(
        [
          "[slide:1]",
          "## Longer but generic title",
          "This is a much longer main-summary extraction that should not replace the completed slide-specific summary just because it has more characters.",
        ].join("\n"),
        { source: "summary" },
      ),
    ).toBe(false);

    expect(controller.getTitles().get(1)).toBe("Canonical title");
    expect(controller.getDescriptions().get(1)).toBe("Concise slide-specific body.");
  });

  it("does not let partial streamed slide markdown block the final summary", () => {
    const slides = [
      { index: 1, timestamp: 0, imageUrl: "x", ocrText: null },
      { index: 2, timestamp: 30, imageUrl: "y", ocrText: null },
    ];
    const controller = createSlidesTextController({
      getSlides: () => slides,
      getLengthValue: () => "short",
      getSlidesOcrEnabled: () => true,
    });

    controller.setTranscriptTimedText(
      "[00:00] Raw transcript intro line.\n[00:30] Raw transcript second line.",
    );
    controller.syncTextState();

    expect(
      controller.updateSummaryFromMarkdown("[slide:1]\n##", {
        source: "slides-partial",
        preserveIfEmpty: true,
      }),
    ).toBe(false);
    expect(controller.getDescriptions().get(1)).toContain("Raw transcript intro line");

    expect(
      controller.updateSummaryFromMarkdown(
        [
          "Scene intro.",
          "",
          "[slide:1]",
          "## Ancient enemy returns",
          "Delenn explains the Shadows as an ancient returning enemy.",
          "",
          "[slide:2]",
          "## Kosh's hidden identity",
          "Kosh is revealed as the remaining guardian watching for the Shadows.",
        ].join("\n"),
        { source: "summary" },
      ),
    ).toBe(true);

    expect(controller.getTitles().get(1)).toBe("Ancient enemy returns");
    expect(controller.getDescriptions().get(1)).toContain("ancient returning enemy");
    expect(controller.getTitles().get(2)).toBe("Kosh's hidden identity");
    expect(controller.getDescriptions().get(2)).toContain("remaining guardian");
    expect(controller.getDescriptions().get(2)).not.toContain("Raw transcript second line");
  });

  it("allows main summary to fill missing cards after an incomplete streamed slide update", () => {
    const slides = [
      { index: 1, timestamp: 0, imageUrl: "x", ocrText: null },
      { index: 2, timestamp: 30, imageUrl: "y", ocrText: null },
    ];
    const controller = createSlidesTextController({
      getSlides: () => slides,
      getLengthValue: () => "short",
      getSlidesOcrEnabled: () => true,
    });

    expect(
      controller.updateSummaryFromMarkdown(
        ["[slide:1]", "## Draft title", "Draft body for one slide."].join("\n"),
        { source: "slides-partial" },
      ),
    ).toBe(true);

    expect(
      controller.updateSummaryFromMarkdown(
        [
          "[slide:1]",
          "## Complete title",
          "Complete body for the first slide.",
          "",
          "[slide:2]",
          "## Second title",
          "Complete body for the second slide.",
        ].join("\n"),
        { source: "summary" },
      ),
    ).toBe(true);

    expect(controller.getTitles().get(1)).toBe("Complete title");
    expect(controller.getTitles().get(2)).toBe("Second title");
    expect(controller.getDescriptions().get(2)).toContain("second slide");
  });

  it("keeps transcript fallback for slides not covered by partial summary markdown", () => {
    const slides = [
      { index: 1, timestamp: 0, imageUrl: "x", ocrText: null },
      { index: 2, timestamp: 30, imageUrl: "y", ocrText: null },
    ];
    const controller = createSlidesTextController({
      getSlides: () => slides,
      getLengthValue: () => "short",
      getSlidesOcrEnabled: () => true,
    });

    controller.setTranscriptTimedText(
      "[00:00] Transcript line for first slide.\n[00:30] Transcript line for second slide.",
    );
    controller.syncTextState();

    expect(
      controller.updateSummaryFromMarkdown(
        ["[slide:1]", "## First title", "Summary body for the first slide."].join("\n"),
        { source: "summary" },
      ),
    ).toBe(true);

    expect(controller.getDescriptions().get(1)).toBe("Summary body for the first slide.");
    expect(controller.getDescriptions().get(2)).toContain("Transcript line for second slide");
  });

  it("allows main summary to replace equal-coverage streamed drafts even when shorter", () => {
    const slides = [
      { index: 1, timestamp: 0, imageUrl: "x", ocrText: null },
      { index: 2, timestamp: 30, imageUrl: "y", ocrText: null },
    ];
    const controller = createSlidesTextController({
      getSlides: () => slides,
      getLengthValue: () => "short",
      getSlidesOcrEnabled: () => true,
    });

    expect(
      controller.updateSummaryFromMarkdown(
        [
          "[slide:1]",
          "## Draft one",
          "Verbose draft body that is still provisional and should not win just because it is longer.",
          "",
          "[slide:2]",
          "## Draft two",
          "Another verbose provisional draft body that is longer than the final card text.",
        ].join("\n"),
        { source: "slides-partial" },
      ),
    ).toBe(true);

    expect(
      controller.updateSummaryFromMarkdown(
        [
          "[slide:1]",
          "## Ancient enemy returns",
          "Ancient enemy returns.",
          "",
          "[slide:2]",
          "## Kosh's hidden identity",
          "Kosh remains hidden.",
        ].join("\n"),
        { source: "summary" },
      ),
    ).toBe(true);

    expect(controller.getTitles().get(1)).toBe("Ancient enemy returns");
    expect(controller.getDescriptions().get(1)).toBe("Ancient enemy returns.");
    expect(controller.getTitles().get(2)).toBe("Kosh's hidden identity");
    expect(controller.getDescriptions().get(2)).toBe("Kosh remains hidden.");
  });

  it("upgrades transcript-first descriptions to slide summaries when summary markdown arrives", () => {
    const slides = [
      { index: 1, timestamp: 0, imageUrl: "x", ocrText: "Ignored OCR text" },
      { index: 2, timestamp: 30, imageUrl: "y", ocrText: "Fallback OCR text for second slide" },
    ];
    const controller = createSlidesTextController({
      getSlides: () => slides,
      getLengthValue: () => "short",
      getSlidesOcrEnabled: () => true,
    });

    controller.setTranscriptTimedText(
      "[00:00] Raw transcript intro line.\n[00:30] Raw transcript second line.",
    );
    controller.syncTextState();
    expect(controller.getDescriptions().get(1)).toContain("Raw transcript intro line");

    controller.updateSummaryFromMarkdown(
      [
        "### Slides",
        "Slide 1 · 0:00",
        "Opening move",
        "Londo notices the trap and keeps the conversation moving.",
        "",
        "Slide 2 · 0:30",
        "Poison reveal",
        "Refa learns the drink is only lethal once both parts are combined.",
      ].join("\n"),
      { source: "slides" },
    );

    expect(controller.getTitles().get(1)).toBe("Opening move");
    expect(controller.getDescriptions().get(1)).toContain(
      "Londo notices the trap and keeps the conversation moving.",
    );
    expect(controller.getDescriptions().get(2)).toContain(
      "Refa learns the drink is only lethal once both parts are combined.",
    );
  });

  it("keeps transcript fallback when a plain summary arrives before local slides", () => {
    let slides: Array<{
      index: number;
      timestamp: number;
      imageUrl: string;
      ocrText: string | null;
    }> = [];
    const controller = createSlidesTextController({
      getSlides: () => slides,
      getLengthValue: () => "short",
      getSlidesOcrEnabled: () => true,
    });

    expect(
      controller.updateSummaryFromMarkdown("A plain video summary without slide markers.", {
        source: "summary",
      }),
    ).toBe(true);

    slides = [
      { index: 1, timestamp: 0, imageUrl: "x", ocrText: null },
      { index: 2, timestamp: 30, imageUrl: "y", ocrText: null },
    ];
    controller.setTranscriptTimedText(
      "[00:00] Local slide one transcript text.\n[00:30] Local slide two transcript text.",
    );
    controller.syncTextState();

    expect(controller.getDescriptions().get(1)).toContain("Local slide one transcript text");
    expect(controller.getDescriptions().get(2)).toContain("Local slide two transcript text");

    expect(
      controller.updateSummaryFromMarkdown("A plain video summary without slide markers.", {
        source: "summary",
        preserveIfEmpty: true,
      }),
    ).toBe(false);
    expect(controller.getDescriptions().get(1)).toContain("Local slide one transcript text");
    expect(controller.getDescriptions().get(2)).toContain("Local slide two transcript text");
  });

  it("keeps explicit OCR mode authoritative even after slide summaries arrive", () => {
    const slides = [
      {
        index: 1,
        timestamp: 0,
        imageUrl: "x",
        ocrText:
          "Readable OCR body for slide one with enough detail to keep the OCR toggle meaningful.",
      },
      {
        index: 2,
        timestamp: 30,
        imageUrl: "y",
        ocrText:
          "Readable OCR body for slide two with enough detail to keep the OCR toggle meaningful.",
      },
      {
        index: 3,
        timestamp: 60,
        imageUrl: "z",
        ocrText:
          "Readable OCR body for slide three with enough detail to keep the OCR toggle meaningful.",
      },
    ];
    const controller = createSlidesTextController({
      getSlides: () => slides,
      getLengthValue: () => "short",
      getSlidesOcrEnabled: () => true,
    });

    controller.syncTextState();
    expect(controller.setTextMode("ocr")).toBe(true);
    controller.updateSummaryFromMarkdown(
      [
        "### Slides",
        "Slide 1 · 0:00",
        "Summary title",
        "Summary body that should not replace OCR mode.",
      ].join("\n"),
      { source: "slides" },
    );

    expect(controller.getDescriptions().get(1)).toContain("Readable OCR body for slide one");
  });

  it("preserves existing titles when asked to ignore empty updates", () => {
    const controller = createSlidesTextController({
      getSlides: () => [{ index: 1, timestamp: 2, imageUrl: "x", ocrText: null }],
      getLengthValue: () => "short",
      getSlidesOcrEnabled: () => true,
    });

    controller.updateSummaryFromMarkdown(
      ["### Slides", "Slide 1 · 0:02", "Kept title", "Some text"].join("\n"),
      { source: "summary" },
    );
    expect(controller.getTitles().get(1)).toBe("Kept title");

    expect(
      controller.updateSummaryFromMarkdown("", {
        source: "summary",
        preserveIfEmpty: true,
      }),
    ).toBe(false);
    expect(controller.getTitles().get(1)).toBe("Kept title");
  });

  it("clears summary titles on empty slide-sourced updates and respects text mode availability", () => {
    const slides = [
      {
        index: 1,
        timestamp: 2,
        imageUrl: "x",
        ocrText: "Readable OCR text for slide one with enough detail to count strongly.",
      },
      {
        index: 2,
        timestamp: 10,
        imageUrl: "y",
        ocrText: "Another readable OCR paragraph for slide two with enough detail to count.",
      },
      {
        index: 3,
        timestamp: 20,
        imageUrl: "z",
        ocrText: "Third readable OCR paragraph for slide three with enough detail to count.",
      },
    ];
    const controller = createSlidesTextController({
      getSlides: () => slides,
      getLengthValue: () => "short",
      getSlidesOcrEnabled: () => true,
    });

    controller.syncTextState();
    expect(controller.getTextToggleVisible()).toBe(true);
    expect(controller.setTextMode("ocr")).toBe(true);
    expect(controller.getTextMode()).toBe("ocr");
    expect(controller.setTextMode("ocr")).toBe(false);

    controller.updateSummaryFromMarkdown(
      ["### Slides", "Slide 1 · 0:02", "Canonical title", "Some text"].join("\n"),
      { source: "slides" },
    );
    expect(controller.hasSummaryTitles()).toBe(true);

    expect(
      controller.updateSummaryFromMarkdown("", {
        source: "slides",
      }),
    ).toBe(true);
    expect(controller.hasSummaryTitles()).toBe(false);
    controller.clearSummarySource();
  });

  it("resets transcript and ocr state cleanly", () => {
    const controller = createSlidesTextController({
      getSlides: () => [{ index: 1, timestamp: 2, imageUrl: "x", ocrText: "tiny" }],
      getLengthValue: () => "short",
      getSlidesOcrEnabled: () => false,
    });

    controller.setTranscriptTimedText("[00:02] Timed line");
    controller.syncTextState();
    expect(controller.getTranscriptAvailable()).toBe(true);
    expect(controller.getTextToggleVisible()).toBe(false);

    controller.reset();
    expect(controller.getTranscriptTimedText()).toBeNull();
    expect(controller.getTranscriptAvailable()).toBe(false);
    expect(controller.getOcrAvailable()).toBe(false);
    expect(controller.getDescriptionEntries()).toEqual([]);
    expect(controller.getTitles().size).toBe(0);
  });
});
