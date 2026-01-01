import type { ExecFileFn } from '../../../markitdown.js'
import { convertToMarkdownWithMarkitdown } from '../../../markitdown.js'
import { formatBytes } from '../../../tty/format.js'
import {
  type AssetAttachment,
  getFileBytesFromAttachment,
  getTextContentFromAttachment,
  shouldMarkitdownConvertMediaType,
} from '../../attachments.js'
import { MAX_TEXT_BYTES_DEFAULT } from '../../constants.js'
import type { ExtractDiagnosticsForFinishLine } from '../../finish-line.js'
import { hasUvxCli } from '../../env.js'
import { withUvxTip } from '../../tips.js'

export type AssetExtractContext = {
  env: Record<string, string | undefined>
  envForRun: Record<string, string | undefined>
  execFileImpl: ExecFileFn
  timeoutMs: number
  preprocessMode: 'off' | 'auto' | 'always'
  format: 'text' | 'markdown'
}

export type AssetExtractResult = {
  content: string
  format: 'text' | 'markdown'
  diagnostics: ExtractDiagnosticsForFinishLine
  footerParts: string[]
}

const baseDiagnostics: ExtractDiagnosticsForFinishLine = {
  strategy: 'html',
  firecrawl: { used: false },
  markdown: { used: false, provider: null },
  transcript: { textProvided: false, provider: null },
}

export async function extractAssetContent({
  ctx,
  attachment,
}: {
  ctx: AssetExtractContext
  attachment: AssetAttachment
}): Promise<AssetExtractResult> {
  const textContent = getTextContentFromAttachment(attachment)
  if (textContent) {
    if (textContent.bytes > MAX_TEXT_BYTES_DEFAULT) {
      throw new Error(
        `Text file too large (${formatBytes(textContent.bytes)}). Limit is ${formatBytes(MAX_TEXT_BYTES_DEFAULT)}.`
      )
    }
    return {
      content: textContent.content,
      format: ctx.format,
      diagnostics: baseDiagnostics,
      footerParts: [],
    }
  }

  if (attachment.kind === 'image') {
    const name = attachment.filename ?? 'image'
    throw new Error(`No extractable text found in ${name} (${attachment.mediaType}).`)
  }

  const fileBytes = getFileBytesFromAttachment(attachment)
  if (!fileBytes) {
    throw new Error('Internal error: missing file bytes for extraction')
  }

  if (ctx.preprocessMode === 'off') {
    throw new Error(
      `This build does not support extracting binary files (${attachment.mediaType}). Enable preprocessing (e.g. --preprocess auto) and install uvx/markitdown.`
    )
  }
  if (!shouldMarkitdownConvertMediaType(attachment.mediaType)) {
    const name = attachment.filename ?? 'file'
    throw new Error(
      `Unsupported file type: ${name} (${attachment.mediaType})\n` +
        `This build can only extract text-like files. Convert this file to text first.`
    )
  }
  if (!hasUvxCli(ctx.env)) {
    throw withUvxTip(
      new Error(`Missing uvx/markitdown for preprocessing ${attachment.mediaType}.`),
      ctx.env
    )
  }

  let markdown: string
  try {
    markdown = await convertToMarkdownWithMarkitdown({
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

  if (Buffer.byteLength(markdown, 'utf8') > MAX_TEXT_BYTES_DEFAULT) {
    throw new Error(
      `Preprocessed Markdown too large (${formatBytes(Buffer.byteLength(markdown, 'utf8'))}). Limit is ${formatBytes(MAX_TEXT_BYTES_DEFAULT)}.`
    )
  }

  return {
    content: markdown,
    format: ctx.format,
    diagnostics: {
      ...baseDiagnostics,
      markdown: { used: true, provider: null, notes: 'markitdown' },
    },
    footerParts: [`markitdown(${attachment.mediaType})`],
  }
}
