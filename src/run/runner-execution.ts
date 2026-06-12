import { pathToFileURL } from "node:url";
import { loadLocalAsset, type InputTarget } from "../content/asset.js";
import { isDirectVideoInput } from "../content/index.js";
import { hasEngineErrorCode } from "../engine/errors.js";
import type { ExecFileFn } from "../markitdown.js";
import { startSpinner } from "../tty/spinner.js";
import type { AssetAttachment } from "./attachments.js";
import { MAX_PDF_EXTRACT_BYTES } from "./constants.js";
import { extractAssetContent } from "./flows/asset/extract.js";
import type { AssetExtractContext } from "./flows/asset/extract.js";
import {
  handleFileInput,
  type AssetInputContext,
  isPdfExtension,
  withUrlAsset,
} from "./flows/asset/input.js";
import { outputExtractedAsset } from "./flows/asset/output.js";
import type { AssetSummaryResult, SummarizeAssetArgs } from "./flows/asset/types.js";
import type { UrlFlowContext } from "./flows/url/types.js";
import { createTempFileFromStdin } from "./stdin-temp-file.js";

function canRetryUrlFlowAfterAssetMiss(ctx: UrlFlowContext): boolean {
  return ctx.flags.firecrawlMode !== "off" && ctx.model.apiStatus.firecrawlConfigured;
}

function allowUrlFlowFirecrawlFallback(ctx: UrlFlowContext): UrlFlowContext {
  return {
    ...ctx,
    flags: { ...ctx.flags, throwOnAssetLikeHtmlError: false },
  };
}

type OutputExtractedAssetContext = Omit<
  Parameters<typeof outputExtractedAsset>[0],
  "url" | "sourceLabel" | "attachment" | "extracted"
>;

export type RunnerExecutionOptions = {
  inputTarget: InputTarget;
  stdin: NodeJS.ReadableStream;
  handleFileInputContext: AssetInputContext;
  url: string | null;
  isYoutubeUrl: boolean;
  withUrlAssetContext: AssetInputContext;
  slidesEnabled: boolean;
  extractMode: boolean;
  progressEnabled: boolean;
  renderSpinnerStatus: (label: string, detail?: string) => string;
  renderSpinnerStatusWithModel: (label: string, modelId: string) => string;
  extractAssetContext: AssetExtractContext & { execFileImpl: ExecFileFn };
  outputExtractedAssetContext: OutputExtractedAssetContext;
  summarizeAsset: (args: SummarizeAssetArgs) => Promise<AssetSummaryResult>;
  runUrlFlowContext: UrlFlowContext;
  executeUrlSummary: (options: {
    ctx: UrlFlowContext;
    url: string;
    isYoutubeUrl: boolean;
  }) => Promise<void>;
};

export async function executeRunnerInput(options: RunnerExecutionOptions) {
  const {
    inputTarget,
    stdin,
    handleFileInputContext,
    url,
    isYoutubeUrl,
    withUrlAssetContext,
    slidesEnabled,
    extractMode,
    progressEnabled,
    renderSpinnerStatus,
    renderSpinnerStatusWithModel,
    extractAssetContext,
    outputExtractedAssetContext,
    summarizeAsset,
    runUrlFlowContext,
    executeUrlSummary,
  } = options;
  const runResolvedUrl = (ctx: UrlFlowContext, targetUrl: string, targetIsYoutubeUrl: boolean) =>
    executeUrlSummary({ ctx, url: targetUrl, isYoutubeUrl: targetIsYoutubeUrl });
  const slidesDirectInputUrl =
    slidesEnabled && inputTarget.kind === "file" && isDirectVideoInput(inputTarget.filePath)
      ? pathToFileURL(inputTarget.filePath).href
      : slidesEnabled && url && isDirectVideoInput(url)
        ? url
        : null;

  if (inputTarget.kind === "stdin") {
    const stdinTempFile = await createTempFileFromStdin({ stream: stdin });
    try {
      const stdinInputTarget = { kind: "file" as const, filePath: stdinTempFile.filePath };
      if (await handleFileInput(handleFileInputContext, stdinInputTarget)) {
        return;
      }
      throw new Error("Failed to process stdin input");
    } finally {
      await stdinTempFile.cleanup();
    }
  }

  // Handle --extract for local PDF files (markitdown path, no LLM needed)
  if (extractMode && inputTarget.kind === "file" && isPdfExtension(inputTarget.filePath)) {
    const spinner = startSpinner({
      text: renderSpinnerStatus("Loading file"),
      enabled: progressEnabled,
      stream: outputExtractedAssetContext.io.stderr,
      color: undefined,
    });
    try {
      const loaded = await loadLocalAsset({
        filePath: inputTarget.filePath,
        maxBytes: MAX_PDF_EXTRACT_BYTES,
      });
      if (progressEnabled) spinner.setText(renderSpinnerStatus("Extracting text"));
      const extracted = await extractAssetContent({
        ctx: extractAssetContext,
        attachment: loaded.attachment,
      });
      spinner.stopAndClear();
      await outputExtractedAsset({
        ...outputExtractedAssetContext,
        url: inputTarget.filePath,
        sourceLabel: loaded.sourceLabel,
        attachment: loaded.attachment,
        extracted,
      });
    } catch (err) {
      spinner.stopAndClear();
      throw err;
    }
    return;
  }

  if (slidesDirectInputUrl && inputTarget.kind === "file") {
    await runResolvedUrl(runUrlFlowContext, slidesDirectInputUrl, false);
    return;
  }

  if (await handleFileInput(handleFileInputContext, inputTarget)) {
    return;
  }

  const tryUrlAsset = async (
    detectUnknownAssetUrls: boolean,
    assumeAsset = false,
  ): Promise<boolean> => {
    if (slidesDirectInputUrl || !url) return false;
    return await withUrlAsset(
      withUrlAssetContext,
      url,
      isYoutubeUrl,
      async ({
        loaded,
        spinner,
      }: {
        loaded: { attachment: AssetAttachment; sourceLabel: string };
        spinner: { setText: (text: string) => void };
      }) => {
        if (extractMode) {
          if (progressEnabled) spinner.setText(renderSpinnerStatus("Extracting text"));
          const extracted = await extractAssetContent({
            ctx: extractAssetContext,
            attachment: loaded.attachment,
          });
          await outputExtractedAsset({
            ...outputExtractedAssetContext,
            url,
            sourceLabel: loaded.sourceLabel,
            attachment: loaded.attachment,
            extracted,
          });
          return;
        }

        if (progressEnabled) spinner.setText(renderSpinnerStatus("Summarizing"));
        await summarizeAsset({
          sourceKind: "asset-url",
          sourceLabel: loaded.sourceLabel,
          attachment: loaded.attachment,
          onModelChosen: (modelId) => {
            if (!progressEnabled) return;
            spinner.setText(renderSpinnerStatusWithModel("Summarizing", modelId));
          },
        });
      },
      { detectUnknownAssetUrls, assumeAsset },
    );
  };

  if (await tryUrlAsset(false)) {
    return;
  }

  if (slidesDirectInputUrl && inputTarget.kind === "url") {
    await runResolvedUrl(runUrlFlowContext, slidesDirectInputUrl, isYoutubeUrl);
    return;
  }

  if (!url) {
    throw new Error("Only HTTP and HTTPS URLs can be summarized");
  }

  try {
    await runResolvedUrl(runUrlFlowContext, url, isYoutubeUrl);
  } catch (error) {
    if (hasEngineErrorCode(error, "ASSET_LIKE_HTML_FETCH")) {
      if (await tryUrlAsset(true, true)) return;
      if (canRetryUrlFlowAfterAssetMiss(runUrlFlowContext)) {
        await runResolvedUrl(allowUrlFlowFirecrawlFallback(runUrlFlowContext), url, isYoutubeUrl);
        return;
      }
    }
    throw error;
  }
}
