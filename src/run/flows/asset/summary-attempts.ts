import path from "node:path";
import { resolveModelAttempts } from "../../../application/model-attempts.js";
import type { CliProvider } from "../../../config.js";
import type { ModelAttempt } from "../../../engine/types.js";
import { buildPathSummaryPrompt } from "../../../prompts/index.js";
import { ensureCliAttachmentPath } from "../../attachments.js";
import type { AssetSummaryContext, SummarizeAssetArgs } from "./types.js";

function isPathBasedAttachment(args: SummarizeAssetArgs): boolean {
  return args.attachment.kind === "image" || args.attachment.kind === "file";
}

function isRemoteCliAttachmentProviderSafe(
  attempt: ModelAttempt,
  args: SummarizeAssetArgs,
): boolean {
  if (attempt.transport !== "cli") return true;
  if (!attempt.cliProvider) return false;
  if (attempt.cliProvider === "opencode") return true;
  return attempt.cliProvider === "codex" && args.attachment.kind === "image";
}

export function filterUnsafeRemoteAssetCliAttempts({
  attempts,
  args,
}: {
  attempts: ModelAttempt[];
  args: SummarizeAssetArgs;
}): ModelAttempt[] {
  if (args.sourceKind !== "asset-url" || !isPathBasedAttachment(args)) return attempts;
  return attempts.filter((attempt) => isRemoteCliAttachmentProviderSafe(attempt, args));
}

export async function buildAssetModelAttempts({
  ctx,
  kind,
  promptTokensForAuto,
  requiresVideoUnderstanding,
  lastSuccessfulCliProvider,
}: {
  ctx: AssetSummaryContext;
  kind: "video" | "image" | "text" | "file";
  promptTokensForAuto: number | null;
  requiresVideoUnderstanding: boolean;
  lastSuccessfulCliProvider: CliProvider | null;
}): Promise<ModelAttempt[]> {
  if (ctx.isFallbackModel) {
    const catalog = await ctx.getLiteLlmCatalog();
    return resolveModelAttempts({
      requestedModel: ctx.requestedModel,
      kind,
      promptTokens: promptTokensForAuto,
      desiredOutputTokens: ctx.desiredOutputTokens,
      requiresVideoUnderstanding,
      envForAuto: ctx.envForAuto,
      configForModelSelection: ctx.configForModelSelection,
      catalog,
      openrouterProvidersFromEnv: null,
      cliAvailability: ctx.cliAvailability,
      isImplicitAutoSelection: ctx.isImplicitAutoSelection,
      allowAutoCliFallback: ctx.allowAutoCliFallback,
      lastSuccessfulCliProvider,
      providerRuntime: ctx.summaryEngine.providerRuntime,
    });
  }

  /* v8 ignore next */
  if (!ctx.fixedModelSpec) {
    throw new Error("Internal error: missing fixed model spec");
  }
  return resolveModelAttempts({
    requestedModel: { kind: "fixed", ...ctx.fixedModelSpec },
    kind,
    promptTokens: promptTokensForAuto,
    desiredOutputTokens: ctx.desiredOutputTokens,
    requiresVideoUnderstanding,
    envForAuto: ctx.envForAuto,
    configForModelSelection: ctx.configForModelSelection,
    catalog: null,
    openrouterProvidersFromEnv: null,
    cliAvailability: ctx.cliAvailability,
    providerRuntime: ctx.summaryEngine.providerRuntime,
  });
}

export async function buildAssetCliContext({
  ctx,
  args,
  attempts,
  attachmentsCount,
  summaryLengthTarget,
}: {
  ctx: AssetSummaryContext;
  args: SummarizeAssetArgs;
  attempts: ModelAttempt[];
  attachmentsCount: number;
  summaryLengthTarget: import("@steipete/summarize-core").SummaryLength | { maxCharacters: number };
}) {
  if (!attempts.some((attempt) => attempt.transport === "cli")) return null;
  if (attachmentsCount === 0) return null;
  const needsPathPrompt = isPathBasedAttachment(args);
  if (!needsPathPrompt) return null;

  const filePath = await ensureCliAttachmentPath({
    sourceKind: args.sourceKind,
    sourceLabel: args.sourceLabel,
    attachment: args.attachment,
  });
  const dir = path.dirname(filePath);
  const isRemoteAsset = args.sourceKind === "asset-url";
  const extraArgsByProvider: Partial<Record<CliProvider, string[]>> = {
    gemini: isRemoteAsset ? undefined : ["--include-directories", dir],
    codex: args.attachment.kind === "image" ? ["-i", filePath] : undefined,
    opencode: ["--file", filePath],
  };

  return {
    promptOverride: buildPathSummaryPrompt({
      kindLabel: args.attachment.kind === "image" ? "image" : "file",
      filePath,
      filename: args.attachment.filename,
      mediaType: args.attachment.mediaType,
      summaryLength: summaryLengthTarget,
      outputLanguage: ctx.outputLanguage,
      promptOverride: ctx.promptOverride ?? null,
      lengthInstruction: ctx.lengthInstruction ?? null,
      languageInstruction: ctx.languageInstruction ?? null,
    }),
    allowTools: !isRemoteAsset,
    cwd: isRemoteAsset ? undefined : dir,
    extraArgsByProvider,
  };
}
