import type { OutputLanguage } from '../language.js'
import { formatOutputLanguageInstruction } from '../language.js'
import type { SummaryLengthTarget } from './link-summary.js'

function formatTargetLength(summaryLength: SummaryLengthTarget): string {
  if (typeof summaryLength === 'string') return ''
  const max = summaryLength.maxCharacters
  return `Target length: around ${max.toLocaleString()} characters total (including Markdown and whitespace). This is a soft guideline; prioritize clarity.`
}

export function buildPathSummaryPrompt({
  kindLabel,
  filePath,
  filename,
  mediaType,
  outputLanguage,
  summaryLength,
}: {
  kindLabel: 'file' | 'image'
  filePath: string
  filename: string | null
  mediaType: string | null
  summaryLength: SummaryLengthTarget
  outputLanguage?: OutputLanguage | null
}): string {
  const headerLines = [
    `Path: ${filePath}`,
    filename ? `Filename: ${filename}` : null,
    mediaType ? `Media type: ${mediaType}` : null,
  ].filter(Boolean)

  const maxCharactersLine = formatTargetLength(summaryLength)
  const languageInstruction = formatOutputLanguageInstruction(outputLanguage ?? { kind: 'auto' })
  return `You summarize ${kindLabel === 'image' ? 'images' : 'files'} for curious users. Summarize the ${kindLabel} at the path below. Be factual and do not invent details. Format the answer in Markdown. Do not use emojis. ${maxCharactersLine} ${languageInstruction}

${headerLines.length > 0 ? `${headerLines.join('\n')}\n\n` : ''}Return only the summary.`
}
