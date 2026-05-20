import { pathToFileURL } from "node:url";
import { loadLocalAsset, type InputTarget } from "../content/asset.js";
import { isDirectVideoInput } from "../content/index.js";
import type { RunMetricsReport } from "../costs.js";
import type { ExecFileFn } from "../markitdown.js";
import { startSpinner } from "../tty/spinner.js";
import type { AssetAttachment } from "./attachments.js";
import { MAX_PDF_EXTRACT_BYTES } from "./constants.js";
import { extractAssetContent } from "./flows/asset/extract.js";
import type { AssetExtractContext } from "./flows/asset/extract.js";
import { handleFileInput, isPdfExtension, withUrlAsset } from "./flows/asset/input.js";
import { outputExtractedAsset } from "./flows/asset/output.js";
import type { SummarizeAssetArgs } from "./flows/asset/summary.js";
import { runUrlFlow } from "./flows/url/flow.js";
import { createTempFileFromStdin } from "./stdin-temp-file.js";

function shouldRetryUrlAsUnknownAsset(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const message = error.message.toLowerCase();
  return (
    message.includes("unsupported binary payload for html document fetch") ||
    message.includes("unsupported content-type for html document fetch") ||
    message.includes("unsupported content-disposition for html document fetch")
  );
}

function canRetryUrlFlowAfterAssetMiss(ctx: unknown): boolean {
  if (!ctx || typeof ctx !== "object") return false;
  const { flags, model } = ctx as {
    flags?: { firecrawlMode?: unknown };
    model?: { apiStatus?: { firecrawlConfigured?: unknown } };
  };
  return flags?.firecrawlMode !== "off" && model?.apiStatus?.firecrawlConfigured === true;
}

function allowUrlFlowFirecrawlFallback(ctx: unknown): unknown {
  if (!ctx || typeof ctx !== "object") return ctx;
  const flags = (ctx as { flags?: unknown }).flags;
  if (!flags || typeof flags !== "object") return ctx;
  return {
    ...(ctx as object),
    flags: { ...(flags as object), throwOnAssetLikeHtmlError: false },
  };
}

export async function executeRunnerInput(options: {
  inputTarget: InputTarget;
  stdin: NodeJS.ReadableStream;
  handleFileInputContext: unknown;
  url: string | null;
  isYoutubeUrl: boolean;
  withUrlAssetContext: unknown;
  slidesEnabled: boolean;
  extractMode: boolean;
  progressEnabled: boolean;
  renderSpinnerStatus: (label: string, detail?: string) => string;
  renderSpinnerStatusWithModel: (label: string, modelId: string) => string;
  extractAssetContext: AssetExtractContext & { execFileImpl: ExecFileFn };
  outputExtractedAssetContext: {
    io: {
      env: Record<string, string | undefined>;
      envForRun: Record<string, string | undefined>;
      stdout: NodeJS.WritableStream;
      stderr: NodeJS.WritableStream;
    };
    flags: {
      timeoutMs: number;
      preprocessMode: "off" | "auto" | "always";
      format: "text" | "markdown";
      plain: boolean;
      json: boolean;
      metricsEnabled: boolean;
      metricsDetailed: boolean;
      shouldComputeReport: boolean;
      runStartedAtMs: number;
      verboseColor: boolean;
    };
    hooks: {
      clearProgressForStdout: () => void;
      restoreProgressAfterStdout?: (() => void) | null;
      buildReport: () => Promise<RunMetricsReport>;
      estimateCostUsd: () => Promise<number | null>;
    };
    apiStatus: {
      xaiApiKey: string | null;
      apiKey: string | null;
      openrouterApiKey: string | null;
      apifyToken: string | null;
      firecrawlConfigured: boolean;
      googleConfigured: boolean;
      anthropicConfigured: boolean;
      openaiApiKey: string | null;
    };
  };
  summarizeAsset: (args: SummarizeAssetArgs) => Promise<void>;
  runUrlFlowContext: unknown;
}) {
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
  } = options;
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
      if (await handleFileInput(handleFileInputContext as never, stdinInputTarget)) {
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
    await runUrlFlow({
      ctx: runUrlFlowContext as never,
      url: slidesDirectInputUrl,
      isYoutubeUrl: false,
    });
    return;
  }

  if (await handleFileInput(handleFileInputContext as never, inputTarget)) {
    return;
  }

  const tryUrlAsset = async (
    detectUnknownAssetUrls: boolean,
    assumeAsset = false,
  ): Promise<boolean> => {
    if (slidesDirectInputUrl || !url) return false;
    return await withUrlAsset(
      withUrlAssetContext as never,
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
    await runUrlFlow({ ctx: runUrlFlowContext as never, url: slidesDirectInputUrl, isYoutubeUrl });
    return;
  }

  if (!url) {
    throw new Error("Only HTTP and HTTPS URLs can be summarized");
  }

  try {
    await runUrlFlow({ ctx: runUrlFlowContext as never, url, isYoutubeUrl });
  } catch (error) {
    if (shouldRetryUrlAsUnknownAsset(error)) {
      if (await tryUrlAsset(true, true)) return;
      if (canRetryUrlFlowAfterAssetMiss(runUrlFlowContext)) {
        await runUrlFlow({
          ctx: allowUrlFlowFirecrawlFallback(runUrlFlowContext) as never,
          url,
          isYoutubeUrl,
        });
        return;
      }
    }
    throw error;
  }
}
