import type { Command } from "commander";
import { createSummarizeExecutionResources } from "../application/execution-resources.js";
import { isTranscribableAssetPath } from "../application/input-acquisition.js";
import { resolveSummarizeRun } from "../application/run-spec.js";
import { resolveCliLocaleFromEnv, translateCliText } from "../locale.js";
import type { ExecFileFn } from "../markitdown.js";
import { resolveSpeakerIdentificationSettings } from "../speaker-identification/index.js";
import {
  createThemeRenderer,
  resolveThemeNameFromSources,
  resolveTrueColor,
} from "../tty/theme.js";
import { createCacheStateFromConfig } from "./cache-state.js";
import { createCliInputProgress } from "./cli-input-progress.js";
import { createCliSummarizeExecutor } from "./cli-summarize-execution.js";
import { createCliSummarizeResolution } from "./cli-summarize-request.js";
import { parseCliProviderArg } from "./env.js";
import { writeVerbose } from "./logging.js";
import { createMediaCacheFromConfig } from "./media-cache-state.js";
import type { PerfTrace } from "./perf-trace.js";
import { createProgressGate } from "./progress.js";
import { resolveRunInput } from "./run-input.js";
import { resolveStreamSettings } from "./run-stream.js";
import { resolveRunnerFlags } from "./runner-flags.js";
import { resolveRunnerSlidesSettings } from "./runner-slides.js";
import { createTerminalSummaryStream } from "./summary-stream.js";
import { isRichTty, supportsColor } from "./terminal.js";

export async function executeCliSummarizeCommand(options: {
  normalizedArgv: string[];
  program: Command;
  env: Record<string, string | undefined>;
  envForRun: Record<string, string | undefined>;
  fetchImpl: typeof fetch;
  execFileImpl: ExecFileFn;
  stdin?: NodeJS.ReadableStream;
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
  promptOverride: string | null;
  perfTrace?: PerfTrace | null;
}): Promise<void> {
  const {
    normalizedArgv,
    program,
    env,
    envForRun,
    fetchImpl,
    execFileImpl,
    stdin,
    stdout,
    stderr,
    perfTrace = null,
  } = options;
  let { promptOverride } = options;
  const programOpts = program.opts() as Record<string, unknown>;

  const cliFlagPresent = normalizedArgv.some((arg) => arg === "--cli" || arg.startsWith("--cli="));
  let cliProviderArgRaw = typeof programOpts.cli === "string" ? programOpts.cli : null;
  const inputResolution = resolveRunInput({
    program,
    cliFlagPresent,
    cliProviderArgRaw,
    env: envForRun,
    stdout,
  });
  perfTrace?.mark("plan:input");
  cliProviderArgRaw = inputResolution.cliProviderArgRaw;
  const inputTarget = inputResolution.inputTarget;
  const url = inputResolution.url;

  const runStartedAtMs = Date.now();
  const flagResolution = resolveRunnerFlags({
    normalizedArgv,
    programOpts,
    envForRun,
    url: inputTarget.kind === "url" ? inputTarget.url : url,
  });
  const {
    lengthExplicitlySet,
    noCacheFlag,
    noMediaCacheFlag,
    extractMode,
    json,
    forceSummary,
    slidesDebug,
    streamMode,
    plain,
    verbose,
    diarizationMode,
    speakerProfileArg,
    speakerAnchorArgs,
    speakerIdentificationOverride,
    rememberSpeakers,
    maxExtractCharacters,
    isYoutubeUrl,
    format,
    youtubeMode,
    maxOutputTokensArg,
    timeoutMs,
    retries,
    preprocessMode,
    markdownMode,
    metricsEnabled,
    metricsDetailed,
    shouldComputeReport,
    markdownModeExplicitlySet,
  } = flagResolution;
  perfTrace?.mark("plan:flags");

  if (extractMode && lengthExplicitlySet && !json && isRichTty(stderr)) {
    stderr.write(
      `${translateCliText("Warning: --length is ignored with --extract (no summary is generated).", resolveCliLocaleFromEnv(envForRun))}\n`,
    );
  }
  const isDirectMediaInput =
    (inputTarget.kind === "file" && isTranscribableAssetPath(inputTarget.filePath)) ||
    (inputTarget.kind === "url" && isTranscribableAssetPath(inputTarget.url));
  if (diarizationMode && !isYoutubeUrl && !isDirectMediaInput) {
    throw new Error("--diarize requires a YouTube URL or a direct audio/video file");
  }

  const modelArg = typeof programOpts.model === "string" ? programOpts.model : null;
  const cliProviderArg =
    typeof cliProviderArgRaw === "string" && cliProviderArgRaw.trim().length > 0
      ? parseCliProviderArg(cliProviderArgRaw)
      : null;
  if (cliFlagPresent && modelArg) {
    throw new Error("Use either --model or --cli (not both).");
  }
  const explicitModelArg = cliProviderArg
    ? `cli/${cliProviderArg}`
    : cliFlagPresent
      ? "auto"
      : modelArg;

  const summarizeResolution = createCliSummarizeResolution({
    input: inputTarget,
    programOpts,
    flags: flagResolution,
    cliFlagPresent,
    cliProvider: cliProviderArg,
    modelOverride: explicitModelArg,
    promptOverride,
  });
  const resolvedRun = resolveSummarizeRun({
    request: summarizeResolution.request,
    env,
    configInput: summarizeResolution.configInput,
    useConfigPromptDefault: true,
  });
  Object.assign(envForRun, resolvedRun.bindings.envForRun);
  const runContext = resolvedRun.bindings.context;
  const { config, openaiRequestOptions, openaiRequestOptionsOverride, cliReasoningEffortOverride } =
    runContext;
  promptOverride = resolvedRun.spec.promptOverride;
  perfTrace?.mark("plan:context");

  const themeName = resolveThemeNameFromSources({
    cli: (programOpts as { theme?: unknown }).theme,
    env: envForRun.SUMMARIZE_THEME,
    config: config?.ui?.theme,
  });
  envForRun.SUMMARIZE_THEME = themeName;

  const slidesSettings = resolveRunnerSlidesSettings({
    normalizedArgv,
    programOpts,
    config,
    inputTarget,
  });
  const transcriptTimestamps = Boolean(programOpts.timestamps) || Boolean(slidesSettings);
  const speakerSource =
    inputTarget.kind === "url"
      ? inputTarget.url
      : inputTarget.kind === "file"
        ? inputTarget.filePath
        : "";
  const speakerIdentification = resolveSpeakerIdentificationSettings({
    config: config?.speakers,
    sourceUrl: speakerSource,
    diarization: diarizationMode,
    profileArg: speakerProfileArg,
    anchorArgs: speakerAnchorArgs,
    identifyOverride: speakerIdentificationOverride,
    remember: rememberSpeakers,
  });

  const transcriptNamespace = `yt:${youtubeMode}`;
  const cacheState = await createCacheStateFromConfig({
    envForRun,
    config,
    noCacheFlag,
    transcriptNamespace,
  });
  try {
    const mediaCache = await createMediaCacheFromConfig({
      envForRun,
      config,
      noMediaCacheFlag,
    });
    perfTrace?.mark("plan:cache");

    if (markdownModeExplicitlySet && format !== "markdown") {
      throw new Error("--markdown-mode is only supported with --format md");
    }
    if (
      markdownModeExplicitlySet &&
      inputTarget.kind !== "url" &&
      inputTarget.kind !== "file" &&
      inputTarget.kind !== "stdin"
    ) {
      throw new Error("--markdown-mode is only supported for URL, file, or stdin inputs");
    }
    if (
      markdownModeExplicitlySet &&
      (inputTarget.kind === "file" || inputTarget.kind === "stdin") &&
      markdownMode !== "llm"
    ) {
      throw new Error(
        "Only --markdown-mode llm is supported for file/stdin inputs; other modes require a URL",
      );
    }

    const verboseColor = supportsColor(stderr, envForRun);
    const themeForStderr = createThemeRenderer({
      themeName,
      enabled: verboseColor,
      trueColor: resolveTrueColor(envForRun),
    });
    const { streamingEnabled } = resolveStreamSettings({
      streamMode,
      stdout,
      json,
      extractMode,
    });

    const progressEnabled = isRichTty(stderr) && !verbose && !json;
    const progressGate = createProgressGate();
    const {
      clearProgressForStdout,
      restoreProgressAfterStdout,
      setClearProgressBeforeStdout,
      clearProgressIfCurrent,
    } = progressGate;

    const requestOptions = {
      openaiRequestOptions,
      openaiRequestOptionsOverride,
      cliReasoningEffortOverride,
    };
    const summaryStream = streamingEnabled
      ? createTerminalSummaryStream({
          stdout,
          env,
          envForRun,
          plain,
          clearProgressForStdout,
          restoreProgressAfterStdout,
        })
      : null;
    const writeViaFooter = (parts: string[]) => {
      if (json || extractMode) return;
      const filtered = parts.map((part) => part.trim()).filter(Boolean);
      if (filtered.length === 0) return;
      clearProgressForStdout();
      stderr.write(
        `${themeForStderr.dim(translateCliText(`via ${filtered.join(", ")}`, resolveCliLocaleFromEnv(envForRun)))}\n`,
      );
      restoreProgressAfterStdout?.();
    };
    const executionResources = createSummarizeExecutionResources({
      resolvedRun,
      env,
      metricsEnv: env,
      fetchImpl,
      execFileImpl,
      cacheState,
      mediaCache,
      stdout,
      stderr,
      summaryStream,
      requestOptions,
      flow: {
        runStartedAtMs,
        streamingEnabled,
        extractMode,
        maxExtractCharacters: extractMode ? maxExtractCharacters : null,
        transcriptTimestamps,
        speakerIdentification,
        summaryCacheBypass: noCacheFlag,
        json,
        metricsEnabled,
        metricsDetailed,
        shouldComputeReport,
        verbose,
        verboseColor,
        progressEnabled,
        streamMode,
        plain,
        slides: slidesSettings,
        slidesDebug,
        slidesOutput: true,
        throwOnAssetLikeHtmlError: true,
      },
      adapterHooks: {
        writeViaFooter,
        clearProgressForStdout,
        restoreProgressAfterStdout,
        setClearProgressBeforeStdout,
        clearProgressIfCurrent,
      },
      log: (message) => writeVerbose(stderr, verbose, message, verboseColor, envForRun),
      trace: (name, detail) => perfTrace?.mark(name, detail),
      perfTrace,
    });
    const { apiStatus } = executionResources.modelResources.runtime;
    const { assetSummaryContext } = executionResources;
    const summarizeRuntime = {
      runId: `cli-${runStartedAtMs}`,
      env,
      fetch: fetchImpl,
      execFile: execFileImpl,
      cache: executionResources.cacheState,
      mediaCache,
      stdin: stdin ?? process.stdin,
    };
    const request = {
      ...summarizeResolution.request,
      input:
        summarizeResolution.request.input.kind === "input-url"
          ? {
              ...summarizeResolution.request.input,
              maxCharacters: extractMode ? maxExtractCharacters : null,
            }
          : summarizeResolution.request.input,
      slides: slidesSettings,
    };
    const inputProgress = createCliInputProgress({
      env,
      envForRun,
      stderr,
      enabled: progressEnabled,
      progressGate,
    });
    const execute = createCliSummarizeExecutor({
      request,
      runtime: summarizeRuntime,
      prepared: executionResources,
      presentationContext: assetSummaryContext,
      progress: inputProgress,
      extractionOutputContext: {
        io: { env, envForRun, stdout, stderr },
        flags: {
          timeoutMs,
          preprocessMode,
          format,
          plain,
          json,
          metricsEnabled,
          metricsDetailed,
          verboseColor,
        },
        hooks: {
          clearProgressForStdout,
          restoreProgressAfterStdout,
        },
        apiStatus,
      },
    });

    perfTrace?.mark("cli:planned");
    await execute();
  } finally {
    cacheState.store?.close();
  }
}
