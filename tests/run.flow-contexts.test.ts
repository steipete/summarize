import { Writable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { createRunFlowContexts } from "../src/application/flow-contexts.js";
import type { CacheState } from "../src/cache.js";
import type { UrlFlowContext } from "../src/run/flows/url/types.js";

const createWritable = () =>
  new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });

describe("run flow contexts", () => {
  it.each([false, true])("derives asset and URL contexts with cache hook=%s", (withCacheHook) => {
    const cacheState = { mode: "off", store: null } as unknown as CacheState;
    const summaryEngine = {} as UrlFlowContext["model"]["summaryEngine"];
    const onModelChosen = vi.fn();
    const onSummaryCached = withCacheHook ? vi.fn() : undefined;
    const runtimeHooks = {
      setTranscriptionCost: vi.fn(),
      writeViaFooter: vi.fn(),
      clearProgressForStdout: vi.fn(),
      restoreProgressAfterStdout: vi.fn(),
      setClearProgressBeforeStdout: vi.fn(),
      clearProgressIfCurrent: vi.fn(),
      buildReport: vi.fn(async () => ({ tokens: 0, calls: 0, durationMs: 0 })),
      estimateCostUsd: vi.fn(async () => null),
    };

    const { assetSummaryContext, urlFlowContext } = createRunFlowContexts({
      cacheState,
      mediaCache: null,
      io: {
        env: {},
        envForRun: {},
        stdout: createWritable(),
        stderr: createWritable(),
        execFileImpl: vi.fn() as unknown as UrlFlowContext["io"]["execFileImpl"],
        fetch: vi.fn() as unknown as typeof fetch,
      },
      flags: {
        timeoutMs: 1_000,
        retries: 1,
        format: "markdown",
        markdownMode: "readability",
        preprocessMode: "auto",
        youtubeMode: "auto",
        firecrawlMode: "off",
        videoMode: "auto",
        embeddedVideoMode: "auto",
        transcriptTimestamps: false,
        transcriptDiarization: null,
        speakerIdentification: null,
        outputLanguage: { kind: "auto" },
        lengthArg: { kind: "preset", preset: "medium" },
        forceSummary: false,
        promptOverride: null,
        lengthInstruction: null,
        languageInstruction: null,
        summaryCacheBypass: false,
        maxOutputTokensArg: null,
        json: false,
        extractMode: false,
        metricsEnabled: false,
        metricsDetailed: false,
        shouldComputeReport: false,
        runStartedAtMs: 1,
        verbose: false,
        verboseColor: false,
        progressEnabled: false,
        streamMode: "on",
        streamingEnabled: true,
        plain: true,
        configPath: null,
        configModelLabel: null,
        slides: null,
        slidesDebug: false,
      },
      model: {
        summaryEngine,
        summaryStream: null,
        apiStatus: {},
      } as unknown as UrlFlowContext["model"],
      runtimeHooks,
      eventHooks: { onModelChosen, onSummaryCached },
      assetFormat: "text",
    });

    expect(assetSummaryContext.format).toBe("text");
    expect(assetSummaryContext.summaryEngine).toBe(summaryEngine);
    expect(assetSummaryContext.cache).toBe(cacheState);
    expect(assetSummaryContext.trackedFetch).toBe(urlFlowContext.io.fetch);
    expect(assetSummaryContext.envForRun).toBe(urlFlowContext.io.envForRun);
    expect(assetSummaryContext.onSummaryCached).toBe(onSummaryCached ?? null);
    expect(assetSummaryContext.writeViaFooter).toBe(runtimeHooks.writeViaFooter);
    expect(assetSummaryContext.restoreProgressAfterStdout).toBe(
      runtimeHooks.restoreProgressAfterStdout,
    );
    expect(assetSummaryContext.timeoutMs).toBe(1_000);
    expect(assetSummaryContext.streamingEnabled).toBe(true);
    expect(urlFlowContext.flags.format).toBe("markdown");
    expect(urlFlowContext.model.summaryEngine).toBe(summaryEngine);
    expect(urlFlowContext.cache).toBe(cacheState);
    expect(urlFlowContext.hooks.onModelChosen).toBe(onModelChosen);
    expect(typeof urlFlowContext.hooks.summarizeAsset).toBe("function");
  });
});
