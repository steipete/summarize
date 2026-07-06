import { describe, expect, it } from "vitest";
import { resolveRunnerSlidesSettings } from "../src/run/runner-slides.js";

describe("resolveRunnerSlidesSettings", () => {
  it("allows slides for local video files", () => {
    const settings = resolveRunnerSlidesSettings({
      normalizedArgv: ["--slides"],
      programOpts: { slides: true },
      config: null,
      inputTarget: { kind: "file", filePath: "/tmp/video.webm" },
    });

    expect(settings?.enabled).toBe(true);
  });

  it("disables auto-tuning when the scene threshold is explicit", () => {
    const settings = resolveRunnerSlidesSettings({
      normalizedArgv: ["--slides", "--slides-scene-threshold", "0.2"],
      programOpts: { slides: true, slidesSceneThreshold: "0.2" },
      config: null,
      inputTarget: { kind: "file", filePath: "/tmp/video.webm" },
    });

    expect(settings?.sceneThreshold).toBe(0.2);
    expect(settings?.autoTuneThreshold).toBe(false);
  });

  it("lets --no-slides disable configured slide extraction", () => {
    const settings = resolveRunnerSlidesSettings({
      normalizedArgv: ["--no-slides"],
      programOpts: { slides: false },
      config: { slides: { enabled: true, ocr: true } },
      inputTarget: { kind: "url", url: "https://www.youtube.com/watch?v=EYSQGkpuzAA" },
    });

    expect(settings).toBeNull();
  });

  it("keeps --slides=false compatible with configured OCR defaults", () => {
    const settings = resolveRunnerSlidesSettings({
      normalizedArgv: ["--slides=false"],
      programOpts: { slides: "false" },
      config: { slides: { ocr: true } },
      inputTarget: { kind: "file", filePath: "/tmp/video.webm" },
    });

    expect(settings?.enabled).toBe(true);
    expect(settings?.ocr).toBe(true);
  });

  it("lets explicit --slides-ocr override --no-slides for the current run", () => {
    const settings = resolveRunnerSlidesSettings({
      normalizedArgv: ["--no-slides", "--slides-ocr"],
      programOpts: { slides: false, slidesOcr: true },
      config: { slides: { enabled: true, ocr: false } },
      inputTarget: { kind: "file", filePath: "/tmp/video.webm" },
    });

    expect(settings?.enabled).toBe(true);
    expect(settings?.ocr).toBe(true);
  });

  it("lets --no-slides-ocr disable configured OCR without disabling slides", () => {
    const settings = resolveRunnerSlidesSettings({
      normalizedArgv: ["--no-slides-ocr"],
      programOpts: { slidesOcr: false },
      config: { slides: { enabled: true, ocr: true } },
      inputTarget: { kind: "file", filePath: "/tmp/video.webm" },
    });

    expect(settings?.enabled).toBe(true);
    expect(settings?.ocr).toBe(false);
  });

  it("rejects slides for stdin", () => {
    expect(() =>
      resolveRunnerSlidesSettings({
        normalizedArgv: ["--slides"],
        programOpts: { slides: true },
        config: null,
        inputTarget: { kind: "stdin" },
      }),
    ).toThrow("--slides is only supported for URLs or local video files");
  });

  it("rejects direct audio URLs", () => {
    expect(() =>
      resolveRunnerSlidesSettings({
        normalizedArgv: ["--slides"],
        programOpts: { slides: true },
        config: null,
        inputTarget: { kind: "url", url: "https://cdn.example.com/audio.mp3" },
      }),
    ).toThrow("--slides is only supported for video URLs or local video files");
  });
});
