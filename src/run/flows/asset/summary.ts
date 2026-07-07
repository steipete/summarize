import { render as renderMarkdownAnsi } from "markdansi";
import {
  readLastSuccessfulCliProvider,
  writeLastSuccessfulCliProvider,
} from "../../../application/cli-fallback-state.js";
import {
  buildAttachmentContentHash,
  buildLanguageKey,
  buildLengthKey,
  buildPromptContentHash,
  buildPromptHash,
} from "../../../cache.js";
import { buildModelMetaFromAttempt } from "../../../engine/model-meta.js";
import { executeSummaryAttempts } from "../../../engine/summary-execution.js";
import type { ModelAttempt } from "../../../engine/types.js";
import { formatOutputLanguageForJson } from "../../../language.js";
import type { Prompt } from "../../../llm/prompt.js";
import { SUMMARY_LENGTH_TARGET_CHARACTERS, SUMMARY_SYSTEM_PROMPT } from "../../../prompts/index.js";
import { buildRunJsonEnv } from "../../../shared/run-api-status.js";
import { countTokens } from "../../../tokenizer.js";
import { isUnsupportedAttachmentError } from "../../attachments.js";
import { writeFinishLine } from "../../finish-line.js";
import { resolveTargetCharacters } from "../../format.js";
import { writeVerbose } from "../../logging.js";
import { prepareMarkdownForTerminal } from "../../markdown.js";
import { isRichTty, markdownRenderWidth, supportsColor } from "../../terminal.js";
import { prepareAssetPrompt } from "./preprocess.js";
import {
  buildAssetCliContext,
  buildAssetModelAttempts,
  filterUnsafeRemoteAssetCliAttempts,
} from "./summary-attempts.js";
import type {
  AssetSummaryContext,
  AssetSummaryContextInput,
  AssetSummaryResult,
  PresentAssetSummaryArgs,
  SummarizeAssetArgs,
} from "./types.js";

function shouldBypassShortContentSummary({
  ctx,
  textContent,
}: {
  ctx: Pick<AssetSummaryContext, "forceSummary" | "lengthArg" | "maxOutputTokensArg" | "json">;
  textContent: { content: string } | null;
}): boolean {
  if (ctx.forceSummary) return false;
  if (!textContent?.content) return false;
  const targetCharacters = resolveTargetCharacters(ctx.lengthArg, SUMMARY_LENGTH_TARGET_CHARACTERS);
  if (!Number.isFinite(targetCharacters) || targetCharacters <= 0) return false;
  if (textContent.content.length > targetCharacters) return false;
  if (!ctx.json && typeof ctx.maxOutputTokensArg === "number") {
    const tokenCount = countTokens(textContent.content);
    if (tokenCount > ctx.maxOutputTokensArg) return false;
  }
  return true;
}

function buildAssetExtracted(args: SummarizeAssetArgs): AssetSummaryResult["extracted"] {
  return {
    kind: "asset" as const,
    source: args.sourceLabel,
    mediaType: args.attachment.mediaType,
    filename: args.attachment.filename,
  };
}

function buildAssetJsonInput(ctx: AssetSummaryContext, args: PresentAssetSummaryArgs) {
  const shared = {
    timeoutMs: ctx.timeoutMs,
    length:
      ctx.lengthArg.kind === "preset"
        ? { kind: "preset" as const, preset: ctx.lengthArg.preset }
        : { kind: "chars" as const, maxCharacters: ctx.lengthArg.maxCharacters },
    maxOutputTokens: ctx.maxOutputTokensArg,
    model: ctx.requestedModelLabel,
    language: formatOutputLanguageForJson(ctx.outputLanguage),
  };
  return args.sourceKind === "file"
    ? { kind: "file" as const, filePath: args.sourceLabel, ...shared }
    : { kind: "asset-url" as const, url: args.sourceLabel, ...shared };
}

async function writeAssetMetrics(ctx: AssetSummaryContext, result: AssetSummaryResult) {
  const report = ctx.shouldComputeReport ? await ctx.buildReport() : null;
  if (!ctx.metricsEnabled || !report) return report;
  const costUsd = await ctx.estimateCostUsd();
  writeFinishLine({
    stderr: ctx.stderr,
    env: ctx.envForRun,
    elapsedMs: Date.now() - ctx.runStartedAtMs,
    elapsedLabel: result.summaryFromCache ? "Cached" : null,
    model: result.llm?.model ?? null,
    report,
    costUsd,
    detailed: ctx.metricsDetailed,
    extraParts: null,
    color: ctx.verboseColor,
  });
  return report;
}

export async function presentAssetSummary(
  ctx: AssetSummaryContext,
  args: PresentAssetSummaryArgs,
  result: AssetSummaryResult,
) {
  if (result.outcome === "attempts-exhausted") {
    ctx.clearProgressForStdout();
    ctx.stdout.write(`${result.summary}\n`);
    ctx.restoreProgressAfterStdout?.();
    if (result.footerParts.length > 0) {
      ctx.writeViaFooter([...result.footerParts, "no model"]);
    }
    return;
  }

  if (ctx.json) {
    ctx.clearProgressForStdout();
    const finishReport = ctx.shouldComputeReport ? await ctx.buildReport() : null;
    const payload = {
      input: buildAssetJsonInput(ctx, args),
      env: buildRunJsonEnv(ctx.apiStatus),
      extracted: result.extracted,
      prompt: result.prompt,
      llm: result.llm,
      metrics: ctx.metricsEnabled ? finishReport : null,
      summary: result.summary,
    };
    ctx.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    ctx.restoreProgressAfterStdout?.();
    if (ctx.metricsEnabled && finishReport) {
      const costUsd = await ctx.estimateCostUsd();
      writeFinishLine({
        stderr: ctx.stderr,
        env: ctx.envForRun,
        elapsedMs: Date.now() - ctx.runStartedAtMs,
        elapsedLabel: result.summaryFromCache ? "Cached" : null,
        model: result.llm?.model ?? null,
        report: finishReport,
        costUsd,
        detailed: ctx.metricsDetailed,
        extraParts: null,
        color: ctx.verboseColor,
      });
    }
    return;
  }

  if (!result.summaryEmitted) {
    ctx.clearProgressForStdout();
    const rendered =
      !ctx.plain && isRichTty(ctx.stdout)
        ? renderMarkdownAnsi(prepareMarkdownForTerminal(result.summary), {
            width: markdownRenderWidth(ctx.stdout, ctx.env),
            wrap: true,
            color: supportsColor(ctx.stdout, ctx.envForRun),
            hyperlinks: true,
          })
        : result.summary;

    if (!ctx.plain && isRichTty(ctx.stdout)) {
      ctx.stdout.write(`\n${rendered.replace(/^\n+/, "")}`);
    } else {
      if (isRichTty(ctx.stdout)) ctx.stdout.write("\n");
      ctx.stdout.write(rendered.replace(/^\n+/, ""));
    }
    if (!rendered.endsWith("\n")) {
      ctx.stdout.write("\n");
    }
    ctx.restoreProgressAfterStdout?.();
  }

  const footerLabel =
    result.outcome === "model"
      ? `model ${result.llm?.model ?? "unknown"}`
      : result.outcome === "short-content"
        ? "short content"
        : "no model";
  if (result.outcome === "model" || result.footerParts.length > 0) {
    ctx.writeViaFooter([...result.footerParts, footerLabel]);
  }

  if (result.outcome !== "token-fit") {
    await writeAssetMetrics(ctx, result);
  }
}

export function createAssetSummaryContext(input: AssetSummaryContextInput): AssetSummaryContext {
  return {
    ...input.io,
    ...input.summary,
    ...input.model,
    ...input.output,
    ...input.hooks,
    ...input.cache,
    apiStatus: input.apiStatus,
  };
}

export async function executeAssetSummary(
  ctx: AssetSummaryContext,
  args: SummarizeAssetArgs,
): Promise<AssetSummaryResult> {
  const lastSuccessfulCliProvider = ctx.isFallbackModel
    ? await readLastSuccessfulCliProvider(ctx.envForRun)
    : null;

  const { promptText, attachments, assetFooterParts, textContent } = await prepareAssetPrompt({
    ctx: {
      env: ctx.env,
      envForRun: ctx.envForRun,
      execFileImpl: ctx.execFileImpl,
      timeoutMs: ctx.timeoutMs,
      preprocessMode: ctx.preprocessMode,
      format: ctx.format,
      lengthArg: ctx.lengthArg,
      outputLanguage: ctx.outputLanguage,
      fixedModelSpec: ctx.fixedModelSpec,
      promptOverride: ctx.promptOverride ?? null,
      lengthInstruction: ctx.lengthInstruction ?? null,
      languageInstruction: ctx.languageInstruction ?? null,
    },
    attachment: args.attachment,
  });
  const prompt: Prompt = {
    system: SUMMARY_SYSTEM_PROMPT,
    userText: promptText,
    ...(attachments.length > 0 ? { attachments } : {}),
  };

  const summaryLengthTarget =
    ctx.lengthArg.kind === "preset"
      ? ctx.lengthArg.preset
      : { maxCharacters: ctx.lengthArg.maxCharacters };

  const promptTokensForAuto = attachments.length === 0 ? countTokens(prompt.userText) : null;
  const lowerMediaType = args.attachment.mediaType.toLowerCase();
  const kind = lowerMediaType.startsWith("video/")
    ? ("video" as const)
    : lowerMediaType.startsWith("image/")
      ? ("image" as const)
      : textContent
        ? ("text" as const)
        : ("file" as const);
  const requiresVideoUnderstanding = kind === "video" && ctx.videoMode !== "transcript";

  if (
    ctx.isFallbackModel &&
    !ctx.isNamedModelSelection &&
    shouldBypassShortContentSummary({ ctx, textContent })
  ) {
    return {
      kind: "summary",
      outcome: "short-content",
      summary: (textContent?.content ?? "").trimEnd(),
      summaryEmitted: false,
      summaryFromCache: false,
      prompt: promptText,
      extracted: buildAssetExtracted(args),
      footerParts: assetFooterParts,
      llm: null,
    };
  }

  if (
    ctx.requestedModel.kind === "auto" &&
    !ctx.isNamedModelSelection &&
    !ctx.forceSummary &&
    !ctx.json &&
    typeof ctx.maxOutputTokensArg === "number" &&
    textContent &&
    countTokens(textContent.content) <= ctx.maxOutputTokensArg
  ) {
    return {
      kind: "summary",
      outcome: "token-fit",
      summary: textContent.content.trim(),
      summaryEmitted: false,
      summaryFromCache: false,
      prompt: promptText,
      extracted: buildAssetExtracted(args),
      footerParts: assetFooterParts,
      llm: null,
    };
  }

  const attempts: ModelAttempt[] = await buildAssetModelAttempts({
    ctx,
    kind,
    promptTokensForAuto,
    requiresVideoUnderstanding,
    lastSuccessfulCliProvider,
  });
  const executableAttempts = filterUnsafeRemoteAssetCliAttempts({ attempts, args });
  if (attempts.length > 0 && executableAttempts.length === 0) {
    throw new Error(
      "Remote image and binary file summaries cannot use CLI providers that require broad local tools. Choose a native model or summarize a local file instead.",
    );
  }

  const cliContext = await buildAssetCliContext({
    ctx,
    args,
    attempts: executableAttempts,
    attachmentsCount: attachments.length,
    summaryLengthTarget,
  });

  const cacheStore =
    ctx.cache.mode === "default" && !ctx.summaryCacheBypass ? ctx.cache.store : null;
  const contentHash = cacheStore
    ? (buildPromptContentHash({ prompt: promptText }) ??
      buildAttachmentContentHash({ attachments }))
    : null;
  const promptHash = cacheStore ? buildPromptHash(promptText) : null;
  const lengthKey = buildLengthKey(ctx.lengthArg);
  const languageKey = buildLanguageKey(ctx.outputLanguage);
  const autoSelectionCacheModel = ctx.isFallbackModel
    ? `selection:${ctx.requestedModelInput.toLowerCase()}`
    : null;

  const execution = await executeSummaryAttempts({
    attempts: executableAttempts,
    isFallbackModel: ctx.isFallbackModel,
    isNamedModelSelection: ctx.isNamedModelSelection,
    wantsFreeNamedModel: ctx.wantsFreeNamedModel,
    requestedModelInput: ctx.requestedModelInput,
    envHasKeyFor: ctx.summaryEngine.envHasKeyFor,
    formatMissingModelError: ctx.summaryEngine.formatMissingModelError,
    cache: {
      store: cacheStore,
      ttlMs: ctx.cache.ttlMs,
      contentHash,
      promptHash,
      lengthKey,
      languageKey,
      autoSelectionModel: autoSelectionCacheModel,
    },
    verbose: (message) =>
      writeVerbose(ctx.stderr, ctx.verbose, message, ctx.verboseColor, ctx.envForRun),
    onModelChosen: args.onModelChosen,
    onCacheResolved: ctx.onSummaryCached ?? null,
    buildCachedResult: (attempt, summary) => ({
      summary,
      summaryEmitted: false,
      modelMeta: buildModelMetaFromAttempt(attempt),
      maxOutputTokensForCall: null,
    }),
    runAttempt: (attempt) =>
      ctx.summaryEngine.runSummaryAttempt({
        attempt,
        prompt,
        allowStreaming: ctx.streamingEnabled,
        onModelChosen: args.onModelChosen ?? null,
        cli: cliContext,
        streamHandler: ctx.summaryStream,
      }),
    onFixedModelError: (attempt, error) => {
      if (isUnsupportedAttachmentError(error)) {
        throw new Error(
          `Model ${attempt.userModelId} does not support attaching files of type ${args.attachment.mediaType}. Try a different --model.`,
          { cause: error },
        );
      }
      throw error;
    },
    fetchImpl: ctx.trackedFetch,
    timeoutMs: ctx.timeoutMs,
    rememberCliProvider: (provider) =>
      writeLastSuccessfulCliProvider({ env: ctx.envForRun, provider }),
  });

  if (!execution.result || !execution.usedAttempt) {
    if (textContent) {
      return {
        kind: "summary",
        outcome: "attempts-exhausted",
        summary: textContent.content.trim(),
        summaryEmitted: false,
        summaryFromCache: false,
        prompt: promptText,
        extracted: buildAssetExtracted(args),
        footerParts: assetFooterParts,
        llm: null,
      };
    }
    if (execution.failure.lastError instanceof Error) throw execution.failure.lastError;
    throw new Error("No model available for this input");
  }

  const { summary, summaryEmitted, modelMeta, maxOutputTokensForCall } = execution.result;
  const usedAttempt = execution.usedAttempt;
  const summaryFromCache = execution.summaryFromCache;

  return {
    kind: "summary",
    outcome: "model",
    summary,
    summaryEmitted,
    summaryFromCache,
    prompt: promptText,
    extracted: buildAssetExtracted(args),
    footerParts: assetFooterParts,
    llm: {
      provider: modelMeta.provider,
      model: usedAttempt.userModelId,
      maxCompletionTokens: maxOutputTokensForCall,
      strategy: "single",
    },
  };
}

export async function summarizeAsset(ctx: AssetSummaryContext, args: SummarizeAssetArgs) {
  const result = await executeAssetSummary(ctx, args);
  await presentAssetSummary(ctx, args, result);
  return result;
}
