import type { SummarizeResult } from "../application/summarize-contracts.js";
import { deriveExtractionUi } from "./flows/url/extract.js";
import {
  createSlidesTerminalOutput,
  type SlidesTerminalOutput,
} from "./flows/url/slides-output.js";
import { outputExtractedUrl, presentExtractedUrlSummary } from "./flows/url/summary.js";
import type { UrlFlowContext } from "./flows/url/types.js";
import { estimateWhisperTranscriptionCostUsd, formatUSD } from "./format.js";

function buildTranscriptionCostLabel(ctx: UrlFlowContext, result: SummarizeResult): string | null {
  const costUsd = estimateWhisperTranscriptionCostUsd({
    transcriptionProvider: result.extracted.transcriptionProvider,
    transcriptSource: result.extracted.transcriptSource,
    mediaDurationSeconds: result.extracted.mediaDurationSeconds,
    openaiWhisperUsdPerMinute: ctx.model.openaiWhisperUsdPerMinute,
  });
  return typeof costUsd === "number" ? `txcost=${formatUSD(costUsd)}` : null;
}

export async function presentCliSummarizeResult(options: {
  ctx: UrlFlowContext;
  result: SummarizeResult;
  slidesOutput?: SlidesTerminalOutput | null;
}): Promise<void> {
  const { ctx, result } = options;
  if (result.details.kind === "delegated-asset") return;
  if (result.input.kind !== "url") {
    throw new Error("CLI URL presentation requires a URL result");
  }

  const extractionUi = deriveExtractionUi(result.extracted);
  const transcriptionCostLabel = buildTranscriptionCostLabel(ctx, result);
  const slidesOutput =
    options.slidesOutput === undefined
      ? createSlidesTerminalOutput({
          io: ctx.io,
          flags: {
            plain: ctx.flags.plain,
            lengthArg: ctx.flags.lengthArg,
            slidesDebug: ctx.flags.slidesDebug,
          },
          extracted: result.extracted,
          slides: result.slides,
          enabled:
            result.kind === "summary" &&
            result.details.kind === "url-summary" &&
            result.details.resolution.kind === "summary" &&
            !result.details.resolution.summaryEmitted &&
            Boolean(ctx.flags.slides) &&
            !ctx.flags.json,
          outputMode: "delta",
          clearProgressForStdout: ctx.hooks.clearProgressForStdout,
          restoreProgressAfterStdout: ctx.hooks.restoreProgressAfterStdout ?? null,
        })
      : options.slidesOutput;
  if (result.kind === "extraction") {
    await outputExtractedUrl({
      ctx,
      url: result.input.url,
      extracted: result.extracted,
      extractionUi,
      prompt: result.details.prompt,
      effectiveMarkdownMode: result.details.effectiveMarkdownMode,
      transcriptionCostLabel,
      slides: result.slides,
      slidesOutput,
    });
    return;
  }
  if (result.details.kind !== "url-summary") {
    throw new Error("CLI URL presentation requires URL summary details");
  }
  await presentExtractedUrlSummary({
    ctx,
    url: result.input.url,
    extracted: result.extracted,
    extractionUi,
    prompt: result.details.prompt,
    effectiveMarkdownMode: result.details.effectiveMarkdownMode,
    transcriptionCostLabel,
    resolution: result.details.resolution,
    slides: result.slides,
    slidesOutput,
  });
}
