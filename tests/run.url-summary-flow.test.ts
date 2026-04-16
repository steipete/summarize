import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import type { CacheStore } from "../src/cache.js";
import type { ExtractedLinkContent } from "../src/content/index.js";
import { parseRequestedModelId } from "../src/model-spec.js";
import { summarizeExtractedUrl } from "../src/run/flows/url/summary.js";
import type { UrlFlowContext } from "../src/run/flows/url/types.js";

function collectStream() {
  let text = "";
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      text += chunk.toString();
      callback();
    },
  });
  return { stream, getText: () => text };
}

const extracted: ExtractedLinkContent = {
  url: "https://www.youtube.com/watch?v=9pUWFJgBc5Q",
  title: "After Babylon 5",
  description: null,
  siteName: "YouTube",
  content: "Transcript:\n[0:00] hello",
  truncated: false,
  totalCharacters: 100,
  wordCount: 20,
  transcriptCharacters: 80,
  transcriptLines: 2,
  transcriptWordCount: 18,
  transcriptSource: "captionTracks",
  transcriptionProvider: null,
  transcriptMetadata: null,
  transcriptSegments: [
    { startMs: 0, endMs: 4_000, text: "hello" },
    { startMs: 772_000, endMs: 775_000, text: "final line" },
  ],
  transcriptTimedText: "[0:00] hello\n[12:54] midpoint\n[19:32] final line",
  mediaDurationSeconds: 1173,
  video: { kind: "youtube", url: "https://www.youtube.com/watch?v=9pUWFJgBc5Q" },
  isVideoOnly: false,
  diagnostics: {
    strategy: "html",
    firecrawl: { attempted: false, used: false, cacheMode: "bypass", cacheStatus: "unknown" },
    markdown: { requested: false, used: false, provider: null },
    transcript: {
      cacheMode: "bypass",
      cacheStatus: "unknown",
      textProvided: true,
      provider: "captionTracks",
      attemptedProviders: ["captionTracks"],
    },
  },
};

describe("summarizeExtractedUrl timestamp guard", () => {
  it("disables streaming and strips impossible key moments before output and cache", async () => {
    const stdout = collectStream();
    const stderr = collectStream();
    const writes = { text: [] as string[], json: [] as unknown[] };
    const fixedModel = parseRequestedModelId("openai/gpt-5.2");
    if (fixedModel.kind !== "fixed" || fixedModel.transport !== "native") {
      throw new Error("expected fixed native model");
    }

    let allowStreamingSeen: boolean | null = null;
    const cacheStore: CacheStore = {
      getText: () => null,
      getJson: () => null,
      setText: (_kind, _key, value) => {
        writes.text.push(value);
      },
      setJson: (_kind, _key, value) => {
        writes.json.push(value);
      },
      clear: () => {},
      close: () => {},
      transcriptCache: {
        get: () => null,
        set: () => {},
      },
    };

    const ctx: UrlFlowContext = {
      io: {
        env: {},
        envForRun: {},
        stdout: stdout.stream,
        stderr: stderr.stream,
        execFileImpl: ((_file, _args, _options, callback) =>
          callback(null, "", "")) as unknown as UrlFlowContext["io"]["execFileImpl"],
        fetch: globalThis.fetch.bind(globalThis),
      },
      flags: {
        timeoutMs: 2_000,
        retries: 1,
        format: "text",
        markdownMode: "off",
        preprocessMode: "auto",
        youtubeMode: "auto",
        firecrawlMode: "off",
        videoMode: "transcript",
        transcriptTimestamps: true,
        outputLanguage: { kind: "auto" },
        lengthArg: { kind: "preset", preset: "medium" },
        forceSummary: false,
        promptOverride: null,
        lengthInstruction: null,
        languageInstruction: null,
        summaryCacheBypass: false,
        maxOutputTokensArg: null,
        json: true,
        extractMode: false,
        metricsEnabled: false,
        metricsDetailed: false,
        shouldComputeReport: false,
        runStartedAtMs: Date.now(),
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
        slidesOutput: false,
      },
      model: {
        requestedModel: fixedModel,
        requestedModelInput: "openai/gpt-5.2",
        requestedModelLabel: "openai/gpt-5.2",
        fixedModelSpec: fixedModel,
        isFallbackModel: false,
        isImplicitAutoSelection: false,
        allowAutoCliFallback: false,
        isNamedModelSelection: true,
        wantsFreeNamedModel: false,
        desiredOutputTokens: null,
        configForModelSelection: null,
        envForAuto: {},
        cliAvailability: {},
        openaiUseChatCompletions: false,
        openaiWhisperUsdPerMinute: 0,
        apiStatus: {
          xaiApiKey: null,
          apiKey: "key",
          nvidiaApiKey: null,
          openrouterApiKey: null,
          openrouterConfigured: false,
          googleApiKey: null,
          googleConfigured: false,
          anthropicApiKey: null,
          anthropicConfigured: false,
          providerBaseUrls: {
            openai: null,
            nvidia: null,
            anthropic: null,
            google: null,
            xai: null,
          },
          zaiApiKey: null,
          zaiBaseUrl: "",
          nvidiaBaseUrl: "",
          firecrawlConfigured: false,
          firecrawlApiKey: null,
          apifyToken: null,
          ytDlpPath: null,
          ytDlpCookiesFromBrowser: null,
          falApiKey: null,
          groqApiKey: null,
          assemblyaiApiKey: null,
          openaiApiKey: null,
        },
        summaryEngine: {
          applyOpenAiGatewayOverrides: (attempt) => attempt,
          envHasKeyFor: () => true,
          formatMissingModelError: () => "missing",
          runSummaryAttempt: async ({ allowStreaming }) => {
            allowStreamingSeen = allowStreaming;
            return {
              summary: [
                "Summary paragraph.",
                "",
                "Key moments",
                "[00:00] Setup",
                "[12:54] Midpoint",
                "[33:10] Impossible ending",
              ].join("\n"),
              summaryAlreadyPrinted: false,
              modelMeta: { provider: "openai", canonical: "openai/gpt-5.2" },
              maxOutputTokensForCall: null,
            };
          },
        } as UrlFlowContext["model"]["summaryEngine"],
        getLiteLlmCatalog: async () => ({ catalog: [] }),
        llmCalls: [],
      },
      cache: { mode: "default", store: cacheStore, ttlMs: 60_000, maxBytes: 1_000_000, path: null },
      mediaCache: null,
      hooks: {
        onModelChosen: null,
        onExtracted: null,
        onSlidesExtracted: null,
        onSlidesProgress: null,
        onSlidesDone: null,
        onLinkPreviewProgress: null,
        onSummaryCached: null,
        setTranscriptionCost: () => {},
        summarizeAsset: async () => {},
        writeViaFooter: () => {},
        clearProgressForStdout: () => {},
        restoreProgressAfterStdout: null,
        setClearProgressBeforeStdout: () => {},
        clearProgressIfCurrent: () => {},
        buildReport: async () => ({ tokens: 0, calls: 0, durationMs: 0 }),
        estimateCostUsd: async () => null,
      },
    };

    await summarizeExtractedUrl({
      ctx,
      url: extracted.url,
      extracted,
      extractionUi: {
        contentSizeLabel: "1 KB",
        viaSourceLabel: "",
        footerParts: [],
        finishSourceLabel: "YouTube",
      },
      prompt: "Prompt",
      effectiveMarkdownMode: "off",
      transcriptionCostLabel: null,
      onModelChosen: null,
    });

    const payload = JSON.parse(stdout.getText()) as { summary: string };
    expect(allowStreamingSeen).toBe(false);
    expect(payload.summary).toContain("[12:54] Midpoint");
    expect(payload.summary).not.toContain("[33:10]");
    expect(writes.text[0]).toContain("[12:54] Midpoint");
    expect(writes.text[0]).not.toContain("[33:10]");
    expect(stderr.getText()).toBe("");
  });
});
