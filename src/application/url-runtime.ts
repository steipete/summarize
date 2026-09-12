import { Writable } from "node:stream";
import type { SummaryStreamHandler } from "../engine/events.js";
import type { UrlFlowContext } from "../run/flows/url/types.js";
import {
  bindSummarizeExecutionEvents,
  createSummarizeExecutionResources,
  type PreparedSummarizeExecution,
} from "./execution-resources.js";
import { resolveSummarizeRun } from "./run-spec.js";
import type {
  SummarizeEventSink,
  SummarizeRequest,
  SummarizeRuntime,
} from "./summarize-contracts.js";

export function createEventSummaryStreamHandler(emit: SummarizeEventSink): SummaryStreamHandler {
  return {
    onChunk: ({ streamed, prevStreamed }) => {
      const normalizedStreamed = streamed.replace(/^\n+/, "");
      const normalizedPrevious = prevStreamed.replace(/^\n+/, "");
      const chunk = normalizedStreamed.startsWith(normalizedPrevious)
        ? normalizedStreamed.slice(normalizedPrevious.length)
        : normalizedStreamed;
      if (!chunk) return false;
      emit({ type: "summary-delta", text: chunk });
      return true;
    },
    onDone: (finalText) => {
      if (finalText.endsWith("\n")) return false;
      emit({ type: "summary-delta", text: "\n" });
      return true;
    },
    onReset: () => {},
  };
}

export function createEventWritable(
  emit: SummarizeEventSink,
  enabled = true,
): NodeJS.WritableStream {
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      const text =
        typeof chunk === "string" ? chunk : Buffer.isBuffer(chunk) ? chunk.toString("utf8") : "";
      if (enabled && text) emit({ type: "summary-delta", text });
      callback();
    },
  });
  (stream as unknown as { isTTY?: boolean }).isTTY = false;
  return stream;
}

export function createSummarizeRuntimeResources(args: {
  request: SummarizeRequest;
  runtime: SummarizeRuntime;
  runStartedAtMs: number;
  emit: SummarizeEventSink;
}): PreparedSummarizeExecution {
  const { request, runtime, runStartedAtMs, emit } = args;
  const { extractOnly, slides } = request;
  const { env, fetch: fetchImpl, urlFetch: urlFetchImpl, cache, mediaCache, execFile } = runtime;
  const { spec, bindings } = resolveSummarizeRun({ request, env });
  const { envForRun } = bindings;
  const stdout = createEventWritable(emit, !extractOnly);
  const stderr = process.stderr;

  const summaryStream = createEventSummaryStreamHandler(emit);
  const directAssetInput =
    request.input.kind === "file" ||
    request.input.kind === "stdin" ||
    request.input.kind === "input-url" ||
    request.input.kind === "resolved-asset" ||
    request.input.kind === "resolved-media";
  const resources = createSummarizeExecutionResources({
    resolvedRun: { spec, bindings },
    env: envForRun,
    metricsEnv: envForRun,
    fetchImpl,
    execFileImpl: execFile,
    cacheState: cache,
    mediaCache,
    stdout,
    stderr,
    urlFetch: urlFetchImpl,
    summaryStream,
    flow: {
      runStartedAtMs,
      streamingEnabled: true,
      extractMode: extractOnly ?? false,
      maxExtractCharacters: spec.maxExtractCharacters,
      slides: slides ?? null,
      throwOnAssetLikeHtmlError: request.input.kind === "input-url" ? true : undefined,
    },
    adapterHooks: {
      writeViaFooter: () => {},
      clearProgressForStdout: () => {},
      restoreProgressAfterStdout: undefined,
      setClearProgressBeforeStdout: () => {},
      clearProgressIfCurrent: () => {},
    },
    assetFormat: directAssetInput ? request.format : "text",
  });

  return bindSummarizeExecutionEvents(resources, emit);
}

export function createSummarizeUrlFlowContext(args: {
  request: SummarizeRequest;
  runtime: SummarizeRuntime;
  runStartedAtMs: number;
  emit: SummarizeEventSink;
}): UrlFlowContext {
  return createSummarizeRuntimeResources(args).urlFlowContext;
}
