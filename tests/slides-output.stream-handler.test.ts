import { describe, expect, it } from "vitest";
import type { ExtractedLinkContent } from "../packages/core/src/content/link-preview/content/types.js";
import {
  createSlidesSummaryStreamHandler,
  createSlidesTerminalOutput,
} from "../src/run/flows/url/slides-output.js";

const makeStdout = (isTTY: boolean) => {
  const chunks: string[] = [];
  const stream = {
    isTTY,
    write: (chunk: string) => {
      chunks.push(String(chunk));
      return true;
    },
  } as unknown as NodeJS.WritableStream;
  return { stream, chunks };
};

describe("slides summary stream handler", () => {
  it("renders markdown in rich TTY and inserts slides inline", async () => {
    const { stream, chunks } = makeStdout(true);
    const renderedSlides: number[] = [];
    const handler = createSlidesSummaryStreamHandler({
      stdout: stream,
      env: { TERM: "xterm" },
      envForRun: { TERM: "xterm" },
      plain: false,
      outputMode: "line",
      clearProgressForStdout: () => {},
      renderSlide: async (index) => {
        renderedSlides.push(index);
        stream.write(`[SLIDE ${index}]\n`);
      },
      getSlideIndexOrder: () => [1],
    });

    const payload = "Hello world\n\n[slide:1]\nAfter slide";
    await handler.onChunk({ streamed: payload, prevStreamed: "", appended: payload });
    await handler.onDone?.(payload);

    const output = chunks.join("");
    expect(output).toContain("Hello");
    expect(output).toContain("[SLIDE 1]");
    expect(output).toContain("After slide");
    expect(output).not.toContain("[slide:1]");
    expect(renderedSlides).toEqual([1]);
  });

  it("keeps slide text interleaved in rich TTY across multiple slide markers", async () => {
    const { stream, chunks } = makeStdout(true);
    const renderedSlides: number[] = [];
    const handler = createSlidesSummaryStreamHandler({
      stdout: stream,
      env: { TERM: "xterm" },
      envForRun: { TERM: "xterm" },
      plain: false,
      outputMode: "line",
      clearProgressForStdout: () => {},
      renderSlide: async (index) => {
        renderedSlides.push(index);
        stream.write(`[SLIDE ${index}]\n`);
      },
      getSlideIndexOrder: () => [1, 2],
    });

    const payload = "Intro\n\n[slide:1]\nFirst block.\n\n[slide:2]\nSecond block.";
    await handler.onChunk({ streamed: payload, prevStreamed: "", appended: payload });
    await handler.onDone?.(payload);

    const output = chunks.join("");
    const firstSlideAt = output.indexOf("[SLIDE 1]");
    const firstTextAt = output.indexOf("First block.");
    const secondSlideAt = output.indexOf("[SLIDE 2]");
    const secondTextAt = output.indexOf("Second block.");
    expect(firstSlideAt).toBeGreaterThanOrEqual(0);
    expect(firstTextAt).toBeGreaterThan(firstSlideAt);
    expect(secondSlideAt).toBeGreaterThan(firstTextAt);
    expect(secondTextAt).toBeGreaterThan(secondSlideAt);
    expect(renderedSlides).toEqual([1, 2]);
  });

  it("streams visible text through the output gate", async () => {
    const { stream, chunks } = makeStdout(false);
    const renderedSlides: number[] = [];
    const handler = createSlidesSummaryStreamHandler({
      stdout: stream,
      env: {},
      envForRun: {},
      plain: true,
      outputMode: "line",
      clearProgressForStdout: () => {},
      renderSlide: async (index) => {
        renderedSlides.push(index);
        stream.write(`[SLIDE ${index}]\n`);
      },
      getSlideIndexOrder: () => [1],
    });

    const payload = "Intro line\n\n[slide:1]\nAfter";
    await handler.onChunk({ streamed: payload, prevStreamed: "", appended: payload });
    await handler.onDone?.(payload);

    const output = chunks.join("");
    expect(output).toContain("Intro line");
    expect(output).toContain("[SLIDE 1]");
    expect(output).toContain("After");
    expect(output).not.toContain("[slide:1]");
    expect(renderedSlides).toEqual([1]);
  });

  it("does not truncate long slide bodies in chunked streams", async () => {
    const { stream, chunks } = makeStdout(false);
    const handler = createSlidesSummaryStreamHandler({
      stdout: stream,
      env: {},
      envForRun: {},
      plain: true,
      outputMode: "line",
      clearProgressForStdout: () => {},
      renderSlide: async (index) => {
        stream.write(`[SLIDE ${index}]\n`);
      },
      getSlideIndexOrder: () => [1, 2],
      getSlideMeta: (index) => ({ total: 2, timestamp: index * 10 }),
    });

    const longOne =
      "Slide one starts with a long narrative that should remain intact even when the model output is chunked in awkward boundaries and does not provide immediate newlines. The handler must keep buffering and preserve every clause from beginning to end without losing words.";
    const longTwo =
      "Slide two continues with another long passage that includes enough text to cross internal thresholds, and the tail sentence should still appear completely after parsing markers in delta-like chunks. This verifies we are not dropping content when switching between slide sections.";
    const payload = `Intro paragraph.\n\n[slide:1]\n${longOne}\n\n[slide:2]\n${longTwo}`;

    for (let i = 0; i < payload.length; i += 31) {
      const chunk = payload.slice(i, i + 31);
      await handler.onChunk({ streamed: payload.slice(0, i + 31), prevStreamed: "", appended: chunk });
    }
    await handler.onDone?.(payload);

    const output = chunks.join("");
    expect(output).toContain("Intro paragraph.");
    expect(output).toContain("preserve every clause from beginning to end");
    expect(output).toContain("tail sentence should still appear completely");
  });

  it("detects headline-style first lines as slide titles", async () => {
    const { stream, chunks } = makeStdout(false);
    const titles: Array<string | null> = [];
    const handler = createSlidesSummaryStreamHandler({
      stdout: stream,
      env: {},
      envForRun: {},
      plain: true,
      outputMode: "line",
      clearProgressForStdout: () => {},
      renderSlide: async (_index, title) => {
        titles.push(title ?? null);
      },
      getSlideIndexOrder: () => [1],
      getSlideMeta: () => ({ total: 1, timestamp: 4 }),
    });

    const payload =
      "Intro line\n\n[slide:1]\nGraphene breakthroughs\nGraphene is strong and conductive.";
    await handler.onChunk({ streamed: payload, prevStreamed: "", appended: payload });
    await handler.onDone?.(payload);

    const output = chunks.join("");
    expect(output).toContain("Graphene is strong and conductive.");
    expect(titles[0]).toContain("Graphene breakthroughs");
  });

  it("handles delta output mode and appends a newline on finalize", async () => {
    const { stream, chunks } = makeStdout(false);
    const handler = createSlidesSummaryStreamHandler({
      stdout: stream,
      env: {},
      envForRun: {},
      plain: true,
      outputMode: "delta",
      clearProgressForStdout: () => {},
      renderSlide: async () => {},
      getSlideIndexOrder: () => [],
    });

    await handler.onChunk({ streamed: "First", prevStreamed: "", appended: "First" });
    await handler.onChunk({ streamed: "Reset", prevStreamed: "First", appended: "Reset" });
    await handler.onDone?.("Reset");

    const output = chunks.join("");
    expect(output).toContain("First");
    expect(output).toContain("Reset");
    expect(output.endsWith("\n")).toBe(true);
  });

  it("returns null when slides output is disabled", () => {
    const { stream } = makeStdout(false);
    const extracted: ExtractedLinkContent = {
      url: "https://example.com",
      title: null,
      description: null,
      siteName: null,
      content: "",
      truncated: false,
      totalCharacters: 0,
      wordCount: 0,
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
      diagnostics: {},
    };

    const output = createSlidesTerminalOutput({
      io: { env: {}, envForRun: {}, stdout: stream, stderr: stream },
      flags: { plain: true, lengthArg: { kind: "preset", preset: "short" } },
      extracted,
      slides: null,
      enabled: false,
      clearProgressForStdout: () => {},
    });

    expect(output).toBeNull();
  });

  it("renders slides inline from markers", async () => {
    const { stream, chunks } = makeStdout(false);
    const extracted: ExtractedLinkContent = {
      url: "https://example.com",
      title: null,
      description: null,
      siteName: null,
      content: "",
      truncated: false,
      totalCharacters: 0,
      wordCount: 0,
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
      diagnostics: {},
    };

    const slides = {
      sourceUrl: "https://example.com",
      sourceKind: "youtube",
      sourceId: "abc",
      slidesDir: "/tmp/slides",
      slidesDirId: null,
      sceneThreshold: 0.3,
      autoTuneThreshold: false,
      autoTune: { enabled: false, chosenThreshold: 0, confidence: 0, strategy: "none" },
      maxSlides: 10,
      minSlideDuration: 5,
      ocrRequested: false,
      ocrAvailable: false,
      slides: [
        { index: 1, timestamp: 10, imagePath: "/tmp/1.png" },
        { index: 2, timestamp: 20, imagePath: "/tmp/2.png" },
      ],
      warnings: [],
    };

    const output = createSlidesTerminalOutput({
      io: { env: {}, envForRun: {}, stdout: stream, stderr: stream },
      flags: { plain: true, lengthArg: { kind: "preset", preset: "short" } },
      extracted,
      slides,
      enabled: true,
      clearProgressForStdout: () => {},
    });

    expect(output).not.toBeNull();
    await output?.renderFromText(["Intro", "[slide:1]", "After"].join("\n"));

    const outputText = chunks.join("");
    expect(outputText).toContain("Slide 1");
    expect(outputText).toContain("Intro");
    expect(outputText).toContain("After");
    expect(outputText).not.toContain("[slide:1]");
  });

  it("prints slide image paths when inline images are unavailable", async () => {
    const { stream, chunks } = makeStdout(true);
    const extracted: ExtractedLinkContent = {
      url: "https://example.com",
      title: null,
      description: null,
      siteName: null,
      content: "",
      truncated: false,
      totalCharacters: 0,
      wordCount: 0,
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
      diagnostics: {},
    };

    const slides = {
      sourceUrl: "https://example.com",
      sourceKind: "youtube",
      sourceId: "abc",
      slidesDir: "/tmp/slides",
      slidesDirId: null,
      sceneThreshold: 0.3,
      autoTuneThreshold: false,
      autoTune: { enabled: false, chosenThreshold: 0, confidence: 0, strategy: "none" },
      maxSlides: 10,
      minSlideDuration: 5,
      ocrRequested: false,
      ocrAvailable: false,
      slides: [{ index: 1, timestamp: 10, imagePath: "/tmp/1.png" }],
      warnings: [],
    };

    const output = createSlidesTerminalOutput({
      io: {
        env: { TERM: "xterm-256color", TERM_PROGRAM: "Apple_Terminal" },
        envForRun: { TERM: "xterm-256color", TERM_PROGRAM: "Apple_Terminal" },
        stdout: stream,
        stderr: stream,
      },
      flags: { plain: false, lengthArg: { kind: "preset", preset: "short" } },
      extracted,
      slides,
      enabled: true,
      clearProgressForStdout: () => {},
    });

    expect(output).not.toBeNull();
    await output?.renderFromText("[slide:1]\nSlide body.");

    const outputText = chunks.join("");
    expect(outputText).toContain("/tmp/1.png");
    expect(outputText).toContain("Slide body.");
  });
});
