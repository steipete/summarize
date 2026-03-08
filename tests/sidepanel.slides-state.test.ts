import { describe, expect, it } from "vitest";
import {
  buildSlideDescriptions,
  formatSlideTimestamp,
  resolveSlidesLengthArg,
  resolveSlidesTextState,
  selectMarkdownForLayout,
} from "../apps/chrome-extension/src/entrypoints/sidepanel/slides-state.js";

describe("sidepanel slides state", () => {
  it("hides the markdown summary in slide gallery mode", () => {
    expect(
      selectMarkdownForLayout({
        markdown: "# Summary\n\nBody",
        slidesEnabled: true,
        inputMode: "video",
        hasSlides: true,
        slidesLayout: "gallery",
      }),
    ).toBe("");
  });

  it("parses custom length values", () => {
    expect(resolveSlidesLengthArg("12k")).toEqual({ kind: "chars", maxCharacters: 12000 });
    expect(resolveSlidesLengthArg("bogus")).toEqual({ kind: "preset", preset: "short" });
  });

  it("formats slide timestamps", () => {
    expect(formatSlideTimestamp(2)).toBe("0:02");
    expect(formatSlideTimestamp(65)).toBe("1:05");
    expect(formatSlideTimestamp(3665)).toBe("1:01:05");
  });

  it("keeps ocr mode hidden when ocr is too weak", () => {
    expect(
      resolveSlidesTextState({
        slides: [{ index: 1, timestamp: 0, imageUrl: "x", ocrText: "tiny" }],
        slidesOcrEnabled: true,
        slidesTranscriptAvailable: true,
        currentMode: "ocr",
      }),
    ).toEqual({
      slidesOcrAvailable: true,
      slidesTextToggleVisible: false,
      slidesTextMode: "transcript",
    });
  });

  it("builds transcript-first descriptions with ocr fallback", () => {
    const descriptions = buildSlideDescriptions({
      slides: [
        {
          index: 1,
          timestamp: 0,
          imageUrl: "x",
          ocrText: "Ignored OCR text",
        },
        {
          index: 2,
          timestamp: 30,
          imageUrl: "y",
          ocrText: "Fallback OCR text for second slide",
        },
      ],
      transcriptTimedText:
        "[00:00] Intro text for the first slide.\n[00:30] Transcript text for the second slide.",
      lengthValue: "short",
      slidesTextMode: "transcript",
      slidesOcrEnabled: true,
      slidesOcrAvailable: true,
      slidesTranscriptAvailable: true,
    });
    expect(descriptions.get(1)).toContain("Intro text");
    expect(descriptions.get(2)).toContain("Transcript text");
  });

  it("keeps markdown visible outside slide gallery mode", () => {
    expect(
      selectMarkdownForLayout({
        markdown: "# Summary\n\nBody",
        slidesEnabled: false,
        inputMode: "page",
        hasSlides: false,
        slidesLayout: "stacked",
      }),
    ).toContain("Body");
  });
});
