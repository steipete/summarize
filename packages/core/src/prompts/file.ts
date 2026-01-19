import type { OutputLanguage } from '../language.js'
import { formatOutputLanguageInstruction } from '../language.js'
import { buildInstructions, buildTaggedPrompt, type PromptOverrides } from './format.js'
import { pickSummaryLengthForCharacters, type SummaryLengthTarget } from './link-summary.js'
import { formatPresetLengthGuidance, resolveSummaryLengthSpec } from './summary-lengths.js'

export function buildFileSummaryPrompt({
  filename,
  mediaType,
  outputLanguage,
  summaryLength,
  contentLength,
  promptOverride,
  lengthInstruction,
  languageInstruction,
}: {
  filename: string | null
  mediaType: string | null
  summaryLength: SummaryLengthTarget
  contentLength?: number | null
  outputLanguage?: OutputLanguage | null
  promptOverride?: string | null
  lengthInstruction?: string | null
  languageInstruction?: string | null
}): string {
  const shouldIgnoreSponsors = Boolean(
    mediaType?.startsWith('audio/') || mediaType?.startsWith('video/')
  )
  const contentCharacters = typeof contentLength === 'number' ? contentLength : null
  const effectiveSummaryLength =
    typeof summaryLength === 'string'
      ? summaryLength
      : contentCharacters &&
          contentCharacters > 0 &&
          summaryLength.maxCharacters > contentCharacters
        ? { maxCharacters: contentCharacters }
        : summaryLength
  const preset =
    typeof effectiveSummaryLength === 'string'
      ? effectiveSummaryLength
      : pickSummaryLengthForCharacters(effectiveSummaryLength.maxCharacters)
  const directive = resolveSummaryLengthSpec(preset)
  const presetLengthLine =
    typeof effectiveSummaryLength === 'string' ? formatPresetLengthGuidance(preset) : ''
  const maxCharactersLine =
    typeof effectiveSummaryLength === 'string'
      ? ''
      : `Target length: up to ${effectiveSummaryLength.maxCharacters.toLocaleString()} characters total (including Markdown and whitespace). Hard limit: do not exceed it.`
  const contentLengthLine =
    contentCharacters && contentCharacters > 0
      ? `Extracted content length: ${contentCharacters.toLocaleString()} characters. Hard limit: never exceed this length. If the requested length is larger, do not pad—finish early rather than adding filler.`
      : ''

  const headerLines = [
    filename ? `Filename: ${filename}` : null,
    mediaType ? `Media type: ${mediaType}` : null,
  ].filter(Boolean)

  const baseInstructions = [
    'You summarize files for curious users.',
    'Summarize the attached file.',
    'Be factual and do not invent details.',
    shouldIgnoreSponsors
      ? 'Ignore sponsor messages, ads, promos, and calls-to-action (including podcast ad reads), even if they appear in the transcript. Do not mention them or that you skipped/ignored them.'
      : '',
    directive.guidance,
    directive.formatting,
    'Format the answer in Markdown.',
    'Use short paragraphs; use bullet lists only when they improve scanability; avoid rigid templates.',
    'When there is a standout line, include 1-2 short direct quotes (max 25 words each) in quotation marks and Markdown italics. Use underscores for italics and place an underscore immediately before the opening quote and immediately after the closing quote. If you cannot italicize a quote, omit it. Do not use quotation marks unless the quoted text is italicized; avoid quotation marks for single words or emphasis. Never quote ads, sponsors, or boilerplate, and never mention them or that you skipped/ignored them.',
    'Do not use emojis.',
    presetLengthLine,
    maxCharactersLine,
    contentLengthLine,
    formatOutputLanguageInstruction(outputLanguage ?? { kind: 'auto' }),
    'Final check: remove any sponsor/ad references. Ensure any quoted text is italicized; if not, remove the quotes.',
    'Return only the summary.',
  ]
    .filter((line) => typeof line === 'string' && line.trim().length > 0)
    .join('\n')

  const instructions = buildInstructions({
    base: baseInstructions,
    overrides: { promptOverride, lengthInstruction, languageInstruction } satisfies PromptOverrides,
  })
  const context = headerLines.join('\n')

  return buildTaggedPrompt({
    instructions,
    context,
    content: '',
  })
}

export function buildFileTextSummaryPrompt({
  filename,
  originalMediaType,
  contentMediaType,
  outputLanguage,
  summaryLength,
  contentLength,
  content,
  promptOverride,
  lengthInstruction,
  languageInstruction,
}: {
  filename: string | null
  originalMediaType: string | null
  contentMediaType: string
  summaryLength: SummaryLengthTarget
  contentLength: number
  outputLanguage?: OutputLanguage | null
  content?: string | null
  promptOverride?: string | null
  lengthInstruction?: string | null
  languageInstruction?: string | null
}): string {
  const shouldIgnoreSponsors = Boolean(
    originalMediaType?.startsWith('audio/') || originalMediaType?.startsWith('video/')
  )
  const effectiveSummaryLength =
    typeof summaryLength === 'string'
      ? summaryLength
      : summaryLength.maxCharacters > contentLength
        ? { maxCharacters: contentLength }
        : summaryLength
  const preset =
    typeof effectiveSummaryLength === 'string'
      ? effectiveSummaryLength
      : pickSummaryLengthForCharacters(effectiveSummaryLength.maxCharacters)
  const directive = resolveSummaryLengthSpec(preset)
  const presetLengthLine =
    typeof effectiveSummaryLength === 'string' ? formatPresetLengthGuidance(preset) : ''
  const maxCharactersLine =
    typeof effectiveSummaryLength === 'string'
      ? ''
      : `Target length: up to ${effectiveSummaryLength.maxCharacters.toLocaleString()} characters total (including Markdown and whitespace). Hard limit: do not exceed it.`

  const headerLines = [
    filename ? `Filename: ${filename}` : null,
    originalMediaType ? `Original media type: ${originalMediaType}` : null,
    `Provided as: ${contentMediaType}`,
    `Extracted content length: ${contentLength.toLocaleString()} characters. Hard limit: never exceed this length. If the requested length is larger, do not pad—finish early rather than adding filler.`,
  ].filter(Boolean)

  const baseInstructions = [
    'You summarize files for curious users.',
    'Summarize the file content below.',
    'Be factual and do not invent details.',
    shouldIgnoreSponsors
      ? 'Ignore sponsor messages, ads, promos, and calls-to-action (including podcast ad reads), even if they appear in the transcript. Do not mention them or that you skipped/ignored them.'
      : '',
    directive.guidance,
    directive.formatting,
    'Format the answer in Markdown.',
    'Use short paragraphs; use bullet lists only when they improve scanability; avoid rigid templates.',
    'When there is a standout line, include 1-2 short direct quotes (max 25 words each) in quotation marks and Markdown italics. Use underscores for italics and place an underscore immediately before the opening quote and immediately after the closing quote. If you cannot italicize a quote, omit it. Do not use quotation marks unless the quoted text is italicized; avoid quotation marks for single words or emphasis. Never quote ads, sponsors, or boilerplate, and never mention them or that you skipped/ignored them.',
    'Do not use emojis.',
    presetLengthLine,
    maxCharactersLine,
    formatOutputLanguageInstruction(outputLanguage ?? { kind: 'auto' }),
    'Final check: remove any sponsor/ad references. Ensure any quoted text is italicized; if not, remove the quotes.',
    'Return only the summary.',
  ]
    .filter((line) => typeof line === 'string' && line.trim().length > 0)
    .join('\n')

  const instructions = buildInstructions({
    base: baseInstructions,
    overrides: { promptOverride, lengthInstruction, languageInstruction } satisfies PromptOverrides,
  })
  const context = headerLines.join('\n')
  const contentText = typeof content === 'string' ? content : ''

  return buildTaggedPrompt({
    instructions,
    context,
    content: contentText,
  })
}
