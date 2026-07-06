import type { SummarizeConfig } from "../config.js";
import type { InputTarget } from "../content/asset.js";
import { isDirectMediaUrl, isDirectVideoInput } from "../content/index.js";
import { resolveSlideSettings, type SlideSettings } from "../slides/index.js";

export function resolveRunnerSlidesSettings(options: {
  normalizedArgv: string[];
  programOpts: Record<string, unknown>;
  config: SummarizeConfig | null;
  inputTarget: InputTarget;
}): SlideSettings | null {
  const { normalizedArgv, programOpts, config, inputTarget } = options;

  const slidesExplicitlySet = normalizedArgv.some(
    (arg) => arg === "--slides" || arg === "--no-slides" || arg.startsWith("--slides="),
  );
  const slidesOcrExplicitlySet = normalizedArgv.some(
    (arg) => arg === "--slides-ocr" || arg === "--no-slides-ocr" || arg.startsWith("--slides-ocr="),
  );
  const slidesDirExplicitlySet = normalizedArgv.some(
    (arg) => arg === "--slides-dir" || arg.startsWith("--slides-dir="),
  );
  const slidesSceneThresholdExplicitlySet = normalizedArgv.some(
    (arg) => arg === "--slides-scene-threshold" || arg.startsWith("--slides-scene-threshold="),
  );
  const slidesMaxExplicitlySet = normalizedArgv.some(
    (arg) => arg === "--slides-max" || arg.startsWith("--slides-max="),
  );
  const slidesMinDurationExplicitlySet = normalizedArgv.some(
    (arg) => arg === "--slides-min-duration" || arg.startsWith("--slides-min-duration="),
  );
  const slidesConfig = config?.slides;
  const slidesValue = slidesExplicitlySet
    ? programOpts.slides
    : (slidesConfig?.enabled ?? programOpts.slides);
  const slidesDisabledExplicitly = normalizedArgv.includes("--no-slides");
  const slidesOcrValue = slidesOcrExplicitlySet
    ? programOpts.slidesOcr
    : slidesDisabledExplicitly
      ? false
      : (slidesConfig?.ocr ?? programOpts.slidesOcr);
  const slidesSettings = resolveSlideSettings({
    slides: slidesValue,
    slidesOcr: slidesOcrValue,
    slidesDir: slidesDirExplicitlySet
      ? programOpts.slidesDir
      : (slidesConfig?.dir ?? programOpts.slidesDir),
    slidesSceneThreshold: slidesSceneThresholdExplicitlySet
      ? programOpts.slidesSceneThreshold
      : (slidesConfig?.sceneThreshold ?? programOpts.slidesSceneThreshold),
    slidesSceneThresholdExplicit:
      slidesSceneThresholdExplicitlySet || typeof slidesConfig?.sceneThreshold === "number",
    slidesMax: slidesMaxExplicitlySet
      ? programOpts.slidesMax
      : (slidesConfig?.max ?? programOpts.slidesMax),
    slidesMinDuration: slidesMinDurationExplicitlySet
      ? programOpts.slidesMinDuration
      : (slidesConfig?.minDuration ?? programOpts.slidesMinDuration),
    cwd: process.cwd(),
  });

  if (!slidesSettings) return null;

  if (inputTarget.kind === "stdin") {
    throw new Error("--slides is only supported for URLs or local video files");
  }

  if (inputTarget.kind === "file" && !isDirectVideoInput(inputTarget.filePath)) {
    throw new Error("--slides is only supported for video URLs or local video files");
  }

  if (
    inputTarget.kind === "url" &&
    isDirectMediaUrl(inputTarget.url) &&
    !isDirectVideoInput(inputTarget.url)
  ) {
    throw new Error("--slides is only supported for video URLs or local video files");
  }

  return slidesSettings;
}
