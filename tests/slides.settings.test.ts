import { describe, expect, it } from "vitest";
import { resolveSlideSettings } from "../src/slides/index.js";

describe("resolveSlideSettings", () => {
  it("returns null when slides are disabled", () => {
    const settings = resolveSlideSettings({ cwd: "/tmp" });
    expect(settings).toBeNull();
  });

  it("defaults when slides are enabled", () => {
    const settings = resolveSlideSettings({ slides: true, cwd: "/tmp" });
    expect(settings).not.toBeNull();
    expect(settings?.outputDir).toBe("/tmp/slides");
    expect(settings?.sceneThreshold).toBe(0.3);
    expect(settings?.autoTuneThreshold).toBe(true);
    expect(settings?.maxSlides).toBe(6);
    expect(settings?.minDurationSeconds).toBe(2);
  });

  it("enables OCR when slidesOcr is set", () => {
    const settings = resolveSlideSettings({ slidesOcr: true, cwd: "/tmp" });
    expect(settings?.ocr).toBe(true);
  });

  it("parses string flags and custom values", () => {
    const settings = resolveSlideSettings({
      slides: "yes",
      slidesOcr: "off",
      slidesDir: "captures",
      slidesSceneThreshold: "0.45",
      slidesMax: "8",
      slidesMinDuration: "5",
      cwd: "/tmp",
    });
    expect(settings).toEqual({
      enabled: true,
      ocr: false,
      outputDir: "/tmp/captures",
      sceneThreshold: 0.45,
      autoTuneThreshold: true,
      maxSlides: 8,
      minDurationSeconds: 5,
    });
  });

  it("disables auto-tuning for an explicit scene threshold", () => {
    const settings = resolveSlideSettings({
      slides: true,
      slidesSceneThreshold: "0.2",
      slidesSceneThresholdExplicit: true,
      cwd: "/tmp",
    });

    expect(settings?.sceneThreshold).toBe(0.2);
    expect(settings?.autoTuneThreshold).toBe(false);
  });

  it("rejects invalid scene threshold", () => {
    expect(() =>
      resolveSlideSettings({ slides: true, slidesSceneThreshold: "2", cwd: "/tmp" }),
    ).toThrow(/slides-scene-threshold/i);
  });

  it("rejects invalid max slides and min duration", () => {
    expect(() => resolveSlideSettings({ slides: true, slidesMax: "0", cwd: "/tmp" })).toThrow(
      /slides-max/i,
    );
    expect(() => resolveSlideSettings({ slides: true, slidesMax: "1e2", cwd: "/tmp" })).toThrow(
      /slides-max/i,
    );
    expect(() => resolveSlideSettings({ slides: true, slidesMax: "0x10", cwd: "/tmp" })).toThrow(
      /slides-max/i,
    );
    expect(() =>
      resolveSlideSettings({ slides: true, slidesMinDuration: "-1", cwd: "/tmp" }),
    ).toThrow(/slides-min-duration/i);
    expect(() =>
      resolveSlideSettings({ slides: true, slidesMinDuration: "1e2", cwd: "/tmp" }),
    ).toThrow(/slides-min-duration/i);
  });

  it("rejects non-decimal scene threshold", () => {
    expect(() =>
      resolveSlideSettings({ slides: true, slidesSceneThreshold: "0x1", cwd: "/tmp" }),
    ).toThrow(/slides-scene-threshold/i);
    expect(() =>
      resolveSlideSettings({ slides: true, slidesSceneThreshold: "1e-1", cwd: "/tmp" }),
    ).toThrow(/slides-scene-threshold/i);
  });
});
