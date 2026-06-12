import { executeSummarize } from "../application/execute-summarize.js";
import type { PreparedSummarizeExecution } from "../application/execution-resources.js";
import type { SummarizeRunRequest } from "../application/run-spec.js";
import type { SummarizeRequest, SummarizeRuntime } from "../application/summarize-contracts.js";
import type { SlideSettings } from "../slides/index.js";
import { presentCliSummarizeResult } from "./cli-summarize-output.js";
import type { AssetExtractResult } from "./flows/asset/extract.js";
import { outputExtractedAsset } from "./flows/asset/output.js";
import { presentAssetSummary } from "./flows/asset/summary.js";
import type {
  AssetSummaryContext,
  AssetSummaryResult,
  SummarizeAssetArgs,
} from "./flows/asset/types.js";
import type { UrlFlowContext } from "./flows/url/types.js";

export type CliUrlSummaryExecutor = (options: {
  ctx: UrlFlowContext;
  url: string;
  isYoutubeUrl: boolean;
}) => Promise<void>;

export function createCliUrlSummaryExecutor(options: {
  baseRequest: SummarizeRunRequest;
  runtime: SummarizeRuntime;
  slides: SlideSettings | null;
  maxExtractCharacters: number | null;
}): CliUrlSummaryExecutor {
  const { input, slides: plannedSlides, ...requestDefaults } = options.baseRequest;
  void input;
  void plannedSlides;

  return async ({ ctx, url, isYoutubeUrl }) => {
    const request: SummarizeRequest = {
      ...requestDefaults,
      input: {
        kind: "url",
        url,
        title: null,
        maxCharacters: options.maxExtractCharacters,
      },
      slides: options.slides,
    };
    const result = await executeSummarize(request, options.runtime, undefined, {
      urlFlowContext: ctx,
      isYoutubeUrl,
    });
    await presentCliSummarizeResult({ ctx, result });
  };
}

export function createCliResolvedAssetExecutor(options: {
  baseRequest: SummarizeRunRequest;
  runtime: SummarizeRuntime;
  prepared: PreparedSummarizeExecution;
  presentationContext: AssetSummaryContext;
  extractionOutputContext: Omit<
    Parameters<typeof outputExtractedAsset>[0],
    "url" | "sourceLabel" | "attachment" | "extracted" | "elapsedMs" | "report" | "costUsd"
  >;
}): {
  summarize: (args: SummarizeAssetArgs) => Promise<AssetSummaryResult>;
  extract: (args: SummarizeAssetArgs) => Promise<AssetExtractResult>;
} {
  const { input, slides, ...requestDefaults } = options.baseRequest;
  void input;
  void slides;

  const execute = async (args: SummarizeAssetArgs, extractOnly: boolean) => {
    const request: SummarizeRequest = {
      ...requestDefaults,
      input: {
        kind: "resolved-asset",
        sourceKind: args.sourceKind,
        sourceLabel: args.sourceLabel,
        attachment: args.attachment,
      },
      extractOnly,
      slides: null,
    };
    const result = await executeSummarize(
      request,
      options.runtime,
      (event) => {
        if (event.type === "model-selected") {
          args.onModelChosen?.(event.modelId);
        }
      },
      options.prepared,
    );
    return result;
  };

  return {
    summarize: async (args) => {
      const result = await execute(args, false);
      if (result.kind !== "asset-summary") {
        throw new Error("CLI resolved asset summary returned an incompatible result");
      }
      await presentAssetSummary(options.presentationContext, args, result.details);
      return result.details;
    },
    extract: async (args) => {
      const result = await execute(args, true);
      if (result.kind !== "asset-extraction") {
        throw new Error("CLI resolved asset extraction returned an incompatible result");
      }
      await outputExtractedAsset({
        ...options.extractionOutputContext,
        url: result.input.source,
        sourceLabel: result.input.source,
        attachment: result.input,
        extracted: result.extracted,
        elapsedMs: result.elapsedMs,
        report: result.report,
        costUsd: result.costUsd,
      });
      return result.extracted;
    },
  };
}
