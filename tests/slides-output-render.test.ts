import { describe, expect, it, vi } from "vitest";
import {
  createInlineSlidesUnsupportedNotifier,
  createSlidesTerminalRenderer,
} from "../src/run/flows/url/slides-output-render.js";

function createBufferStream() {
  let text = "";
  return {
    stream: {
      write(chunk: string) {
        text += chunk;
      },
    } as NodeJS.WritableStream,
    read() {
      return text;
    },
  };
}

describe("slides output render", () => {
  it("shows the inline unsupported notice once with the right reason", () => {
    const stderr = createBufferStream();
    const clearProgressForStdout = vi.fn();
    const restoreProgressAfterStdout = vi.fn();
    const notify = createInlineSlidesUnsupportedNotifier({
      inlineNoticeEnabled: true,
      io: { stderr: stderr.stream },
      richTty: false,
      clearProgressForStdout,
      restoreProgressAfterStdout,
    });

    notify({ slidesDir: "", sourceUrl: "https://example.com", slides: [] });
    expect(stderr.read()).toBe("");

    notify({ slidesDir: "/tmp/slides", sourceUrl: "https://example.com", slides: [] });
    notify({ slidesDir: "/tmp/slides-2", sourceUrl: "https://example.com/2", slides: [] });

    expect(stderr.read()).toContain(
      "Slides saved to /tmp/slides. Inline images unavailable (stdout is not a TTY).",
    );
    expect(stderr.read()).toContain(
      'Use summarize slides "https://example.com" --output "/tmp/slides" to export only.',
    );
    expect(clearProgressForStdout).toHaveBeenCalledTimes(1);
    expect(restoreProgressAfterStdout).toHaveBeenCalledTimes(1);
  });

  it("renders inline slides, truncates long titles, and reports progress", async () => {
    const stdout = createBufferStream();
    const clearProgressForStdout = vi.fn();
    const restoreProgressAfterStdout = vi.fn();
    const renderSlide = vi.fn(async () => true);
    const onProgressText = vi.fn();
    const waitForSlide = vi.fn(async () => ({
      index: 1,
      timestamp: 12,
      imagePath: "/tmp/slide-1.png",
    }));
    const renderer = createSlidesTerminalRenderer({
      io: { stdout: stdout.stream },
      flags: {},
      inlineEnabled: true,
      richTty: false,
      inlineRenderer: { renderSlide },
      labelTheme: {
        dim: (text) => `<d>${text}</d>`,
        heading: (text) => `<h>${text}</h>`,
      },
      clearProgressForStdout,
      restoreProgressAfterStdout,
      onProgressText,
      getOrder: () => [1, 2],
      getSlide: () => ({ index: 1, timestamp: 12, imagePath: null }),
      getSourceUrl: () => "https://example.com/watch",
      waitForSlide,
      initialSlides: null,
    });

    await renderer(
      1,
      "This title is intentionally very long so the renderer has to truncate it before printing the heading line to stdout for slide mode.",
    );

    expect(waitForSlide).toHaveBeenCalledWith(1);
    expect(renderSlide).toHaveBeenCalledWith(
      { index: 1, timestamp: 12, imagePath: "/tmp/slide-1.png" },
      null,
    );
    expect(stdout.read()).toContain(
      "<h>This title is intentionally very long so the renderer has to truncate it before printin...</h> <d>· 0:12</d>",
    );
    expect(onProgressText).toHaveBeenCalledWith("Slides 1/2");
    expect(clearProgressForStdout).toHaveBeenCalled();
    expect(restoreProgressAfterStdout).toHaveBeenCalled();
  });

  it("skips inline rendering for non-positive indices and debug-prints missing image paths", async () => {
    const stdout = createBufferStream();
    const renderSlide = vi.fn(async () => true);
    const renderer = createSlidesTerminalRenderer({
      io: { stdout: stdout.stream },
      flags: { slidesDebug: true },
      inlineEnabled: true,
      richTty: true,
      inlineRenderer: { renderSlide },
      labelTheme: {
        dim: (text) => text,
        heading: (text) => text,
      },
      clearProgressForStdout: vi.fn(),
      restoreProgressAfterStdout: vi.fn(),
      onProgressText: null,
      getOrder: () => [1],
      getSlide: (index) =>
        index === 1
          ? { index: 1, timestamp: Number.NaN, imagePath: "/tmp/missing-slide.png" }
          : null,
      getSourceUrl: () => "https://example.com/watch",
      waitForSlide: vi.fn(async () => null),
      initialSlides: {
        slides: [{ index: 1, timestamp: 0, imageUrl: "", ocrText: null }],
        sourceUrl: "https://example.com/watch",
        slidesDir: "/tmp/slides",
      },
    });

    await renderer(0, "Ignored");
    await renderer(1, null);

    expect(renderSlide).not.toHaveBeenCalled();
    expect(stdout.read()).toContain("/tmp/missing-slide.png (missing)");
  });

  it("prints plain labels when no title or inline image is available", async () => {
    const stdout = createBufferStream();
    const renderer = createSlidesTerminalRenderer({
      io: { stdout: stdout.stream },
      flags: {},
      inlineEnabled: false,
      richTty: false,
      inlineRenderer: null,
      labelTheme: {
        dim: (text) => `[${text}]`,
        heading: (text) => text,
      },
      clearProgressForStdout: vi.fn(),
      restoreProgressAfterStdout: null,
      onProgressText: vi.fn(),
      getOrder: () => [],
      getSlide: () => ({ index: 3, timestamp: 75, imagePath: "/tmp/slide-3.png" }),
      getSourceUrl: () => "https://example.com/watch",
      waitForSlide: vi.fn(async () => null),
      initialSlides: null,
    });

    await renderer(3, "");
    expect(stdout.read()).toContain("[Slide 3 · 1:15]");
  });
});
