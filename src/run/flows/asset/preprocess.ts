import type { SummaryLength } from "@steipete/summarize-core";
import type { OutputLanguage } from "../../../language.js";
import type { Attachment } from "../../../llm/attachments.js";
import { resolveOpenAiClientConfig } from "../../../llm/providers/openai.js";
import type { FixedModelSpec } from "../../../model-spec.js";
import { buildFileSummaryPrompt, buildFileTextSummaryPrompt } from "../../../prompts/index.js";
import { formatBytes } from "../../../tty/format.js";
import {
  type AssetAttachment,
  getFileBytesFromAttachment,
  MAX_DOCUMENT_BYTES_DEFAULT,
  shouldMarkitdownConvertMediaType,
  supportsNativeFileAttachment,
} from "../../attachments.js";
import { type AssetConversionContext, convertAssetToMarkdown, readAssetText } from "./content.js";

export type AssetPreprocessContext = AssetConversionContext & {
  preprocessMode: "off" | "auto" | "always";
  format: "text" | "markdown";
  lengthArg: { kind: "preset"; preset: SummaryLength } | { kind: "chars"; maxCharacters: number };
  outputLanguage: OutputLanguage;
  fixedModelSpec: FixedModelSpec | null;
  promptOverride?: string | null;
  lengthInstruction?: string | null;
  languageInstruction?: string | null;
  openaiApiKey?: string | null;
  openrouterApiKey?: string | null;
  openaiBaseUrl?: string | null;
};

export type AssetPreprocessResult = {
  promptText: string;
  attachments: Attachment[];
  assetFooterParts: string[];
  textContent: { content: string; bytes: number } | null;
};

export type DocumentHandlingDecision =
  | { mode: "inline" }
  | { mode: "attach" }
  | { mode: "preprocess" }
  | { mode: "error"; error: Error };

export function resolveDocumentHandling({
  attachment,
  textContent,
  fileBytes,
  preprocessMode,
  fixedModelSpec,
  openaiApiKey,
  openrouterApiKey,
  openaiBaseUrl,
}: {
  attachment: AssetAttachment;
  textContent: { content: string; bytes: number } | null;
  fileBytes: Uint8Array | null;
  preprocessMode: "off" | "auto" | "always";
  fixedModelSpec: FixedModelSpec | null;
  openaiApiKey?: string | null;
  openrouterApiKey?: string | null;
  openaiBaseUrl?: string | null;
}): DocumentHandlingDecision {
  if (attachment.kind !== "file") return { mode: "inline" };
  if (textContent) return { mode: "inline" };
  if (!fileBytes) {
    return {
      mode: "error",
      error: new Error("Internal error: missing file bytes for binary attachment"),
    };
  }

  const canAttachDocument = (() => {
    if (preprocessMode === "always") return false;
    if (fixedModelSpec?.transport !== "native") return false;
    if (
      !supportsNativeFileAttachment({
        provider: fixedModelSpec.provider,
        attachment: { kind: attachment.kind, mediaType: attachment.mediaType },
      })
    ) {
      return false;
    }
    if (fixedModelSpec.provider !== "openai") return true;
    const resolvedOpenAiBaseUrl = fixedModelSpec.openaiBaseUrlOverride ?? openaiBaseUrl ?? null;
    try {
      const openaiConfig = resolveOpenAiClientConfig({
        apiKeys: { openaiApiKey: openaiApiKey ?? null, openrouterApiKey: openrouterApiKey ?? null },
        forceOpenRouter: fixedModelSpec.forceOpenRouter,
        openaiBaseUrlOverride: resolvedOpenAiBaseUrl,
        forceChatCompletions: fixedModelSpec.forceChatCompletions,
      });
      if (openaiConfig.isOpenRouter) return false;
      const host = new URL(openaiConfig.baseURL ?? "https://api.openai.com/v1").host.toLowerCase();
      return host === "api.openai.com";
    } catch {
      if (!resolvedOpenAiBaseUrl) return true;
      try {
        return new URL(resolvedOpenAiBaseUrl).host.toLowerCase() === "api.openai.com";
      } catch {
        return false;
      }
    }
  })();

  if (canAttachDocument && fileBytes.byteLength <= MAX_DOCUMENT_BYTES_DEFAULT) {
    return { mode: "attach" };
  }

  if (canAttachDocument && fileBytes.byteLength > MAX_DOCUMENT_BYTES_DEFAULT) {
    if (preprocessMode === "off") {
      return {
        mode: "error",
        error: new Error(
          `PDF is too large to attach (${formatBytes(fileBytes.byteLength)}). Max is ${formatBytes(MAX_DOCUMENT_BYTES_DEFAULT)}. Enable preprocessing or use a smaller file.`,
        ),
      };
    }
    return { mode: "preprocess" };
  }

  if (preprocessMode === "off") {
    return {
      mode: "error",
      error: new Error(
        `This build does not support attaching binary files (${attachment.mediaType}). Enable preprocessing (e.g. --preprocess auto) and install uvx/markitdown.`,
      ),
    };
  }

  return { mode: "preprocess" };
}

export async function prepareAssetPrompt({
  ctx,
  attachment,
}: {
  ctx: AssetPreprocessContext;
  attachment: AssetAttachment;
}): Promise<AssetPreprocessResult> {
  const textContent = readAssetText(attachment);
  const fileBytes = getFileBytesFromAttachment(attachment);
  const promptOptions = {
    filename: attachment.filename,
    summaryLength:
      ctx.lengthArg.kind === "preset"
        ? ctx.lengthArg.preset
        : { maxCharacters: ctx.lengthArg.maxCharacters },
    outputLanguage: ctx.outputLanguage,
    promptOverride: ctx.promptOverride ?? null,
    lengthInstruction: ctx.lengthInstruction ?? null,
    languageInstruction: ctx.languageInstruction ?? null,
  };
  const documentHandling = resolveDocumentHandling({
    attachment,
    textContent,
    fileBytes,
    preprocessMode: ctx.preprocessMode,
    fixedModelSpec: ctx.fixedModelSpec,
    openaiApiKey: ctx.openaiApiKey ?? (ctx.envForRun.OPENAI_API_KEY?.trim() || null),
    openrouterApiKey: ctx.openrouterApiKey ?? (ctx.envForRun.OPENROUTER_API_KEY?.trim() || null),
    openaiBaseUrl: ctx.openaiBaseUrl ?? (ctx.envForRun.OPENAI_BASE_URL?.trim() || null),
  });
  if (documentHandling.mode === "error") throw documentHandling.error;

  if (attachment.kind === "image" || documentHandling.mode === "attach") {
    const bytes = attachment.kind === "image" ? attachment.bytes : fileBytes;
    if (!bytes) throw new Error("Internal error: missing file bytes for document attachment");
    return {
      promptText: buildFileSummaryPrompt({
        ...promptOptions,
        mediaType: attachment.mediaType,
        contentLength: textContent?.content.length ?? null,
      }),
      attachments: [
        {
          kind: attachment.kind === "image" ? "image" : "document",
          mediaType: attachment.mediaType,
          bytes,
          filename: attachment.filename,
        },
      ],
      assetFooterParts: [],
      textContent,
    };
  }

  let inline = textContent
    ? { content: textContent.content, mediaType: attachment.mediaType }
    : null;
  const assetFooterParts: string[] = [];
  if (documentHandling.mode === "preprocess") {
    if (!fileBytes)
      throw new Error("Internal error: missing file bytes for markitdown preprocessing");
    if (!shouldMarkitdownConvertMediaType(attachment.mediaType)) {
      throw new Error(
        `Unsupported file type: ${attachment.filename ?? "file"} (${attachment.mediaType})\n` +
          "This build can only send text or images to the model. Try a text-like file, an image, or convert this file to text first.",
      );
    }
    const { markdown, usedOcr } = await convertAssetToMarkdown(ctx, attachment, fileBytes);
    if (!markdown) throw new Error("Internal error: missing markitdown content for preprocessing");
    inline = { content: markdown, mediaType: "text/markdown" };
    assetFooterParts.push(`markitdown${usedOcr ? "+ocr" : ""}(${attachment.mediaType})`);
  }
  if (!inline) throw new Error("Internal error: no prompt text could be built for asset");
  return {
    promptText: buildFileTextSummaryPrompt({
      ...promptOptions,
      originalMediaType: attachment.mediaType,
      contentMediaType: inline.mediaType,
      contentLength: inline.content.length,
      content: inline.content,
    }),
    attachments: [],
    assetFooterParts,
    textContent,
  };
}
