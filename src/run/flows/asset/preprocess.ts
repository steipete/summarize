import type { OutputLanguage } from '../../../language.js'
import { buildDocumentPrompt, type PromptPayload } from '../../../llm/prompt.js'
import { convertToMarkdownWithMarkitdown } from '../../../markitdown.js'
import type { FixedModelSpec } from '../../../model-spec.js'
import { buildFileSummaryPrompt, buildFileTextSummaryPrompt } from '../../../prompts/index.js'
import type { SummaryLength } from '../../../shared/contracts.js'
import { formatBytes } from '../../../tty/format.js'
import {
  type AssetAttachment,
  MAX_DOCUMENT_BYTES_DEFAULT,
  buildAssetPromptPayload,
  getFileBytesFromAttachment,
  getTextContentFromAttachment,
  shouldMarkitdownConvertMediaType,
  supportsNativeFileAttachment,
} from '../../attachments.js'
import { MAX_TEXT_BYTES_DEFAULT } from '../../constants.js'
import { hasUvxCli } from '../../env.js'
import { withUvxTip } from '../../tips.js'

export type AssetPreprocessContext = {
  env: Record<string, string | undefined>
  envForRun: Record<string, string | undefined>
  execFileImpl: Parameters<typeof convertToMarkdownWithMarkitdown>[0]['execFileImpl']
  timeoutMs: number
  preprocessMode: 'off' | 'auto' | 'always'
  format: 'text' | 'markdown'
  lengthArg: { kind: 'preset'; preset: SummaryLength } | { kind: 'chars'; maxCharacters: number }
  outputLanguage: OutputLanguage
  fixedModelSpec: FixedModelSpec | null
  promptOverride?: string | null
  lengthInstruction?: string | null
  languageInstruction?: string | null
}

export type AssetPreprocessResult = {
  promptPayload: PromptPayload
  promptText: string
  assetFooterParts: string[]
  textContent: { content: string; bytes: number } | null
}

export async function prepareAssetPrompt({
  ctx,
  attachment,
}: {
  ctx: AssetPreprocessContext
  attachment: AssetAttachment
}): Promise<AssetPreprocessResult> {
  const textContent = getTextContentFromAttachment(attachment)
  if (textContent && textContent.bytes > MAX_TEXT_BYTES_DEFAULT) {
    throw new Error(
      `Text file too large (${formatBytes(textContent.bytes)}). Limit is ${formatBytes(MAX_TEXT_BYTES_DEFAULT)}.`
    )
  }

  const fileBytes = getFileBytesFromAttachment(attachment)

  const summaryLengthTarget =
    ctx.lengthArg.kind === 'preset'
      ? ctx.lengthArg.preset
      : { maxCharacters: ctx.lengthArg.maxCharacters }

  let promptText = ''
  const assetFooterParts: string[] = []

  const buildImagePromptPayload = () => {
    if (attachment.kind !== 'image') {
      throw new Error(
        'Internal error: tried to build image prompt payload for non-image attachment'
      )
    }
    promptText = buildFileSummaryPrompt({
      filename: attachment.filename,
      mediaType: attachment.mediaType,
      summaryLength: summaryLengthTarget,
      contentLength: textContent?.content.length ?? null,
      outputLanguage: ctx.outputLanguage,
      promptOverride: ctx.promptOverride ?? null,
      lengthInstruction: ctx.lengthInstruction ?? null,
      languageInstruction: ctx.languageInstruction ?? null,
    })
    return buildAssetPromptPayload({ promptText, attachment })
  }

  const buildInlinePromptPayload = ({
    content,
    contentMediaType,
    originalMediaType,
  }: {
    content: string
    contentMediaType: string
    originalMediaType: string | null
  }) => {
    promptText = buildFileTextSummaryPrompt({
      filename: attachment.filename,
      originalMediaType,
      contentMediaType,
      summaryLength: summaryLengthTarget,
      contentLength: content.length,
      outputLanguage: ctx.outputLanguage,
      content,
      promptOverride: ctx.promptOverride ?? null,
      lengthInstruction: ctx.lengthInstruction ?? null,
      languageInstruction: ctx.languageInstruction ?? null,
    })
    return promptText
  }

  let preprocessedMarkdown: string | null = null
  let usingPreprocessedMarkdown = false

  const canUseNativeFileAttachment =
    attachment.kind === 'file' &&
    !textContent &&
    ctx.preprocessMode !== 'always' &&
    ctx.fixedModelSpec?.transport === 'native' &&
    supportsNativeFileAttachment({
      provider: ctx.fixedModelSpec.provider,
      attachment: { kind: attachment.kind, mediaType: attachment.mediaType },
    })

  if (canUseNativeFileAttachment) {
    if (!fileBytes) {
      throw new Error('Internal error: missing file bytes for document attachment')
    }
    if (fileBytes.byteLength > MAX_DOCUMENT_BYTES_DEFAULT) {
      if (ctx.preprocessMode === 'off') {
        throw new Error(
          `PDF is too large to attach (${formatBytes(fileBytes.byteLength)}). Max is ${formatBytes(MAX_DOCUMENT_BYTES_DEFAULT)}. Enable preprocessing or use a smaller file.`
        )
      }
    } else {
      promptText = buildFileSummaryPrompt({
        filename: attachment.filename,
        mediaType: attachment.mediaType,
        summaryLength: summaryLengthTarget,
        contentLength: textContent?.content.length ?? null,
        outputLanguage: ctx.outputLanguage,
        promptOverride: ctx.promptOverride ?? null,
        lengthInstruction: ctx.lengthInstruction ?? null,
        languageInstruction: ctx.languageInstruction ?? null,
      })
      const promptPayload = buildDocumentPrompt({
        text: promptText,
        document: {
          bytes: fileBytes,
          mediaType: attachment.mediaType,
          filename: attachment.filename,
        },
      })
      return { promptPayload, promptText, assetFooterParts, textContent }
    }
  }

  // Non-text file attachments require preprocessing (pi-ai message format supports images, but not generic files).
  if (attachment.kind === 'file' && !textContent) {
    if (!fileBytes) {
      throw new Error('Internal error: missing file bytes for markitdown preprocessing')
    }
    if (ctx.preprocessMode === 'off') {
      throw new Error(
        `This build does not support attaching binary files (${attachment.mediaType}). Enable preprocessing (e.g. --preprocess auto) and install uvx/markitdown.`
      )
    }
    if (!shouldMarkitdownConvertMediaType(attachment.mediaType)) {
      throw new Error(
        `Unsupported file type: ${attachment.filename ?? 'file'} (${attachment.mediaType})\n` +
          `This build can only send text or images to the model. Try a text-like file, an image, or convert this file to text first.`
      )
    }
    if (!hasUvxCli(ctx.env)) {
      throw withUvxTip(
        new Error(`Missing uvx/markitdown for preprocessing ${attachment.mediaType}.`),
        ctx.env
      )
    }

    try {
      preprocessedMarkdown = await convertToMarkdownWithMarkitdown({
        bytes: fileBytes,
        filenameHint: attachment.filename,
        mediaTypeHint: attachment.mediaType,
        uvxCommand: ctx.envForRun.UVX_PATH,
        timeoutMs: ctx.timeoutMs,
        env: ctx.env,
        execFileImpl: ctx.execFileImpl,
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw new Error(`Failed to preprocess ${attachment.mediaType} with markitdown: ${message}.`)
    }
    if (Buffer.byteLength(preprocessedMarkdown, 'utf8') > MAX_TEXT_BYTES_DEFAULT) {
      throw new Error(
        `Preprocessed Markdown too large (${formatBytes(Buffer.byteLength(preprocessedMarkdown, 'utf8'))}). Limit is ${formatBytes(MAX_TEXT_BYTES_DEFAULT)}.`
      )
    }
    usingPreprocessedMarkdown = true
    assetFooterParts.push(`markitdown(${attachment.mediaType})`)
  }

  let promptPayload: PromptPayload
  if (attachment.kind === 'image') {
    promptPayload = buildImagePromptPayload()
  } else if (usingPreprocessedMarkdown) {
    if (!preprocessedMarkdown)
      throw new Error('Internal error: missing markitdown content for preprocessing')
    promptPayload = buildInlinePromptPayload({
      content: preprocessedMarkdown,
      contentMediaType: 'text/markdown',
      originalMediaType: attachment.mediaType,
    })
  } else if (textContent) {
    promptPayload = buildInlinePromptPayload({
      content: textContent.content,
      contentMediaType: attachment.mediaType,
      originalMediaType: attachment.mediaType,
    })
  } else {
    throw new Error('Internal error: no prompt payload could be built for asset')
  }

  void ctx.fixedModelSpec

  return { promptPayload, promptText, assetFooterParts, textContent }
}
