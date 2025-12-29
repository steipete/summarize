import type { OutputLanguage } from '../../../language.js'
import type { Attachment } from '../../../llm/attachments.js'
import { convertToMarkdownWithMarkitdown } from '../../../markitdown.js'
import type { FixedModelSpec } from '../../../model-spec.js'
import { buildFileSummaryPrompt, buildFileTextSummaryPrompt } from '../../../prompts/index.js'
import type { SummaryLength } from '../../../shared/contracts.js'
import { formatBytes } from '../../../tty/format.js'
import {
  type AssetAttachment,
  getFileBytesFromAttachment,
  getTextContentFromAttachment,
  MAX_DOCUMENT_BYTES_DEFAULT,
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
  promptText: string
  attachments: Attachment[]
  assetFooterParts: string[]
  textContent: { content: string; bytes: number } | null
}

export type DocumentHandlingDecision =
  | { mode: 'inline' }
  | { mode: 'attach' }
  | { mode: 'preprocess' }
  | { mode: 'error'; error: Error }

export function resolveDocumentHandling({
  attachment,
  textContent,
  fileBytes,
  preprocessMode,
  fixedModelSpec,
}: {
  attachment: AssetAttachment
  textContent: { content: string; bytes: number } | null
  fileBytes: Uint8Array | null
  preprocessMode: 'off' | 'auto' | 'always'
  fixedModelSpec: FixedModelSpec | null
}): DocumentHandlingDecision {
  if (attachment.kind !== 'file') return { mode: 'inline' }
  if (textContent) return { mode: 'inline' }
  if (!fileBytes) {
    return {
      mode: 'error',
      error: new Error('Internal error: missing file bytes for binary attachment'),
    }
  }

  const canAttachDocument =
    preprocessMode !== 'always' &&
    fixedModelSpec?.transport === 'native' &&
    supportsNativeFileAttachment({
      provider: fixedModelSpec.provider,
      attachment: { kind: attachment.kind, mediaType: attachment.mediaType },
    })

  if (canAttachDocument && fileBytes.byteLength <= MAX_DOCUMENT_BYTES_DEFAULT) {
    return { mode: 'attach' }
  }

  if (canAttachDocument && fileBytes.byteLength > MAX_DOCUMENT_BYTES_DEFAULT) {
    if (preprocessMode === 'off') {
      return {
        mode: 'error',
        error: new Error(
          `PDF is too large to attach (${formatBytes(fileBytes.byteLength)}). Max is ${formatBytes(MAX_DOCUMENT_BYTES_DEFAULT)}. Enable preprocessing or use a smaller file.`
        ),
      }
    }
    return { mode: 'preprocess' }
  }

  if (preprocessMode === 'off') {
    return {
      mode: 'error',
      error: new Error(
        `This build does not support attaching binary files (${attachment.mediaType}). Enable preprocessing (e.g. --preprocess auto) and install uvx/markitdown.`
      ),
    }
  }

  return { mode: 'preprocess' }
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
  let attachments: Attachment[] = []
  const assetFooterParts: string[] = []

  const buildImageAttachment = () => {
    if (attachment.kind !== 'image') {
      throw new Error('Internal error: tried to attach non-image as image')
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
    attachments = [
      {
        kind: 'image',
        mediaType: attachment.mediaType,
        bytes: attachment.bytes,
        filename: attachment.filename,
      },
    ]
  }

  const buildInlinePromptText = ({
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
  }

  let preprocessedMarkdown: string | null = null
  let usingPreprocessedMarkdown = false

  const documentHandling =
    attachment.kind === 'file'
      ? resolveDocumentHandling({
          attachment,
          textContent,
          fileBytes,
          preprocessMode: ctx.preprocessMode,
          fixedModelSpec: ctx.fixedModelSpec,
        })
      : { mode: 'inline' as const }

  if (documentHandling.mode === 'error') {
    throw documentHandling.error
  }

  if (documentHandling.mode === 'attach') {
    if (!fileBytes) {
      throw new Error('Internal error: missing file bytes for document attachment')
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
    attachments = [
      {
        kind: 'document',
        mediaType: attachment.mediaType,
        bytes: fileBytes,
        filename: attachment.filename,
      },
    ]
    return { promptText, attachments, assetFooterParts, textContent }
  }

  // Non-text file attachments require preprocessing (pi-ai message format supports images, but not generic files).
  if (attachment.kind === 'file' && !textContent && documentHandling.mode === 'preprocess') {
    if (!fileBytes) {
      throw new Error('Internal error: missing file bytes for markitdown preprocessing')
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

  if (attachment.kind === 'image') {
    buildImageAttachment()
  } else if (usingPreprocessedMarkdown) {
    if (!preprocessedMarkdown)
      throw new Error('Internal error: missing markitdown content for preprocessing')
    buildInlinePromptText({
      content: preprocessedMarkdown,
      contentMediaType: 'text/markdown',
      originalMediaType: attachment.mediaType,
    })
  } else if (textContent) {
    buildInlinePromptText({
      content: textContent.content,
      contentMediaType: attachment.mediaType,
      originalMediaType: attachment.mediaType,
    })
  } else {
    throw new Error('Internal error: no prompt text could be built for asset')
  }

  void ctx.fixedModelSpec

  return { promptText, attachments, assetFooterParts, textContent }
}
