import type { CacheState } from "../cache.js";
import type { MediaCache } from "../content/index.js";
import { summarizeAsset as summarizeAssetFlow } from "../run/flows/asset/summary.js";
import type { AssetSummaryContext, SummarizeAssetArgs } from "../run/flows/asset/types.js";
import {
  createUrlFlowContext,
  type UrlFlowContext,
  type UrlFlowEventHooks,
  type UrlFlowRuntimeHooks,
} from "../run/flows/url/types.js";
import type { PerfTrace } from "../run/perf-trace.js";

export function createRunFlowContexts(options: {
  cacheState: CacheState;
  mediaCache: MediaCache | null;
  io: UrlFlowContext["io"];
  flags: UrlFlowContext["flags"];
  model: UrlFlowContext["model"];
  runtimeHooks: Omit<UrlFlowRuntimeHooks, "summarizeAsset">;
  eventHooks?: Partial<UrlFlowEventHooks>;
  assetFormat?: AssetSummaryContext["format"];
  perfTrace?: PerfTrace | null;
}) {
  const {
    cacheState,
    mediaCache,
    io,
    flags,
    model,
    runtimeHooks,
    eventHooks,
    assetFormat,
    perfTrace = null,
  } = options;

  const assetSummaryContext: AssetSummaryContext = {
    ...io,
    ...flags,
    ...model,
    ...runtimeHooks,
    format: assetFormat ?? flags.format,
    trackedFetch: io.fetch,
    onSummaryCached: eventHooks?.onSummaryCached ?? null,
    cache: cacheState,
    mediaCache,
  };

  const summarizeAsset = (args: SummarizeAssetArgs) =>
    summarizeAssetFlow(assetSummaryContext, args);

  return {
    assetSummaryContext,
    summarizeAsset,
    urlFlowContext: createUrlFlowContext({
      io,
      flags,
      model,
      cache: cacheState,
      mediaCache,
      perfTrace,
      runtimeHooks: {
        ...runtimeHooks,
        summarizeAsset,
      },
      eventHooks,
    }),
  };
}
