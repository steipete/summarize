import { loadRemoteAsset } from "../../../content/asset.js";
import { type ExtractedLinkContent } from "../../../content/index.js";
import type { SlideExtractionResult } from "../../../slides/index.js";
import { assertAssetMediaTypeSupported } from "../../attachments.js";
import { writeVerbose } from "../../logging.js";
import { deriveExtractionUi, type UrlExtractionUi } from "./extract.js";
import type { UrlFlowContext } from "./types.js";

export type VideoOnlyResult =
  | { handled: true }
  | {
      handled: false;
      extracted: ExtractedLinkContent;
      extractionUi: UrlExtractionUi;
    };

export async function handleVideoOnlyExtractedContent({
  ctx,
  extracted,
  extractionUi,
  isYoutubeUrl,
  fetchWithCache,
  runSlidesExtraction,
  renderStatus,
  renderStatusWithMeta,
  spinner,
  styleDim,
  updateSummaryProgress,
  accent,
}: {
  ctx: UrlFlowContext;
  extracted: ExtractedLinkContent;
  extractionUi: UrlExtractionUi;
  isYoutubeUrl: boolean;
  fetchWithCache: (url: string) => Promise<ExtractedLinkContent>;
  runSlidesExtraction: () => Promise<SlideExtractionResult | null>;
  renderStatus: (label: string, detail?: string) => string;
  renderStatusWithMeta: (label: string, meta: string, suffix?: string) => string;
  spinner: { setText: (text: string) => void };
  styleDim: (text: string) => string;
  updateSummaryProgress: () => void;
  accent: (text: string) => string;
}): Promise<VideoOnlyResult> {
  const { io, flags, model, hooks } = ctx;
  if (isYoutubeUrl || !extracted.isVideoOnly || !extracted.video) {
    return { handled: false, extracted, extractionUi };
  }
  if (extracted.video.url.startsWith("file://")) {
    return { handled: false, extracted, extractionUi };
  }

  if (extracted.video.kind === "youtube") {
    writeVerbose(
      io.stderr,
      flags.verbose,
      `video-only page detected; switching to YouTube URL ${extracted.video.url}`,
      flags.verboseColor,
      io.envForRun,
    );
    if (flags.progressEnabled) {
      spinner.setText(renderStatus("Video-only page", ": fetching YouTube transcript…"));
    }
    const nextExtracted = await fetchWithCache(extracted.video.url);
    return {
      handled: false,
      extracted: nextExtracted,
      extractionUi: deriveExtractionUi(nextExtracted),
    };
  }

  const directVideoSlides = await runSlidesExtraction();
  const wantsVideoUnderstanding = flags.videoMode === "understand" || flags.videoMode === "auto";
  const canVideoUnderstand =
    wantsVideoUnderstanding &&
    model.apiStatus.googleConfigured &&
    (model.requestedModel.kind === "auto" ||
      (model.fixedModelSpec?.transport === "native" && model.fixedModelSpec.provider === "google"));

  if (!canVideoUnderstand) {
    return { handled: false, extracted, extractionUi };
  }

  hooks.onExtracted?.(extracted);
  if (flags.progressEnabled) spinner.setText(renderStatus("Downloading video"));
  const loadedVideo = await loadRemoteAsset({
    url: extracted.video.url,
    fetchImpl: io.urlFetch ?? io.fetch,
    timeoutMs: flags.timeoutMs,
  });
  assertAssetMediaTypeSupported({ attachment: loadedVideo.attachment, sizeLabel: null });

  let chosenModel: string | null = null;
  if (flags.progressEnabled) spinner.setText(renderStatus("Summarizing video"));
  await hooks.summarizeAsset({
    sourceKind: "asset-url",
    sourceLabel: loadedVideo.sourceLabel,
    attachment: loadedVideo.attachment,
    onModelChosen: (modelId) => {
      chosenModel = modelId;
      hooks.onModelChosen?.(modelId);
      if (flags.progressEnabled) {
        const meta = `${styleDim("(")}${styleDim("model: ")}${accent(modelId)}${styleDim(")")}`;
        spinner.setText(renderStatusWithMeta("Summarizing video", meta));
      }
    },
  });
  const slideCount = directVideoSlides ? directVideoSlides.slides.length : null;
  hooks.writeViaFooter([
    ...extractionUi.footerParts,
    ...(chosenModel ? [`model ${chosenModel}`] : []),
    ...(slideCount != null ? [`slides ${slideCount}`] : []),
  ]);
  updateSummaryProgress();
  return { handled: true };
}
