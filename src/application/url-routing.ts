import { pathToFileURL } from "node:url";
import { hasEngineErrorCode } from "../engine/errors.js";
import { executeUrlFlow, type UrlFlowResult } from "../run/flows/url/flow.js";
import type { UrlFlowContext } from "../run/flows/url/types.js";
import type { AcquiredAssetExecutionResult, AcquiredAssetExecutor } from "./asset-execution.js";
import {
  acquireRemoteAssetInput,
  createRemoteMediaInput,
  materializeAcquiredMediaInput,
  resolveUrlAssetRoute,
} from "./input-acquisition.js";
import type {
  SummarizeEventSink,
  SummarizeInput,
  SummarizeRequest,
} from "./summarize-contracts.js";

type PreparedInput = Exclude<SummarizeInput, { kind: "file" | "stdin" }>;
type RoutedInput = Exclude<PreparedInput, { kind: "input-url" }>;
type RawUrlInput = Extract<SummarizeInput, { kind: "input-url" }>;
type UrlInput = Extract<SummarizeInput, { kind: "url" }>;

function toUrlInput(input: RawUrlInput): UrlInput {
  return { ...input, kind: "url" };
}

function emitLoading(input: RawUrlInput, emit: SummarizeEventSink) {
  emit({
    type: "input-progress",
    phase: "loading",
    source: input.url,
    filename: null,
    mediaType: null,
    sizeBytes: null,
  });
}

export async function resolveInitialUrlInput({
  input,
  request,
  isYoutubeUrl,
  ctx,
  assetExecutor,
  emit,
}: {
  input: PreparedInput;
  request: SummarizeRequest;
  isYoutubeUrl: boolean;
  ctx: UrlFlowContext;
  assetExecutor: AcquiredAssetExecutor;
  emit: SummarizeEventSink;
}): Promise<{ input: RoutedInput; rawUrlInput: RawUrlInput | null }> {
  if (input.kind !== "input-url") return { input, rawUrlInput: null };

  const route = await resolveUrlAssetRoute({
    url: input.url,
    isYoutubeUrl,
    fetchImpl: ctx.io.urlFetch ?? ctx.io.fetch,
    timeoutMs: ctx.flags.timeoutMs,
    detectUnknownAssetUrls: false,
  });
  if (route === "audio" || route === "video") {
    if (request.slides && route === "video") {
      return { input: toUrlInput(input), rawUrlInput: input };
    }
    const acquired = createRemoteMediaInput(input.url);
    assetExecutor.emitProgress(acquired);
    return { input: acquired, rawUrlInput: input };
  }
  if (route === "asset") {
    emitLoading(input, emit);
    const acquired = await acquireRemoteAssetInput({
      url: input.url,
      fetchImpl: ctx.io.urlFetch ?? ctx.io.fetch,
      timeoutMs: ctx.flags.timeoutMs,
    });
    if (acquired) {
      assetExecutor.emitProgress(acquired);
      return { input: acquired, rawUrlInput: input };
    }
  }
  return { input: toUrlInput(input), rawUrlInput: input };
}

function canRetryWithFirecrawl(ctx: UrlFlowContext): boolean {
  return ctx.flags.firecrawlMode !== "off" && ctx.model.apiStatus.firecrawlConfigured;
}

function allowFirecrawlFallback(ctx: UrlFlowContext): UrlFlowContext {
  return {
    ...ctx,
    flags: { ...ctx.flags, throwOnAssetLikeHtmlError: false },
  };
}

export async function executeUrlWithAssetFallback({
  input,
  rawUrlInput,
  request,
  isYoutubeUrl,
  ctx,
  assetExecutor,
  emit,
}: {
  input: UrlInput;
  rawUrlInput: RawUrlInput | null;
  request: SummarizeRequest;
  isYoutubeUrl: boolean;
  ctx: UrlFlowContext;
  assetExecutor: AcquiredAssetExecutor;
  emit: SummarizeEventSink;
}): Promise<UrlFlowResult | AcquiredAssetExecutionResult> {
  try {
    return await executeUrlFlow({ ctx, url: input.url, isYoutubeUrl });
  } catch (error) {
    if (!rawUrlInput || !hasEngineErrorCode(error, "ASSET_LIKE_HTML_FETCH")) throw error;

    emitLoading(rawUrlInput, emit);
    const fallbackRoute = await resolveUrlAssetRoute({
      url: rawUrlInput.url,
      isYoutubeUrl,
      fetchImpl: ctx.io.urlFetch ?? ctx.io.fetch,
      timeoutMs: ctx.flags.timeoutMs,
      detectUnknownAssetUrls: true,
      assumeAsset: true,
    });
    if (
      (fallbackRoute === "audio" || fallbackRoute === "video") &&
      (!request.slides || fallbackRoute === "audio")
    ) {
      const acquired = createRemoteMediaInput(rawUrlInput.url);
      assetExecutor.emitProgress(acquired);
      return await assetExecutor.execute(acquired);
    }
    if (fallbackRoute === "asset" || (fallbackRoute === "video" && request.slides)) {
      const acquired = await acquireRemoteAssetInput({
        url: rawUrlInput.url,
        fetchImpl: ctx.io.urlFetch ?? ctx.io.fetch,
        timeoutMs: ctx.flags.timeoutMs,
      });
      if (acquired) {
        assetExecutor.emitProgress(acquired);
        if (
          acquired.kind === "resolved-media" &&
          request.slides &&
          acquired.attachment.mediaType.toLowerCase().startsWith("video/")
        ) {
          const materialized = await materializeAcquiredMediaInput(acquired);
          try {
            return await executeUrlFlow({
              ctx,
              url: pathToFileURL(materialized.filePath).href,
              isYoutubeUrl: false,
            });
          } finally {
            await materialized.cleanup();
          }
        }
        return await assetExecutor.execute(acquired);
      }
    }
    if (canRetryWithFirecrawl(ctx)) {
      return await executeUrlFlow({
        ctx: allowFirecrawlFallback(ctx),
        url: input.url,
        isYoutubeUrl,
      });
    }
    throw error;
  }
}
