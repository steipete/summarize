import type { OutputLanguage } from '../language.js'
import { formatOutputLanguageInstruction } from '../language.js'
import type { SummaryLength } from '../shared/contracts.js'
import { buildInstructions, buildTaggedPrompt, type PromptOverrides } from './format.js'
import {
  formatPresetLengthGuidance,
  resolveSummaryLengthSpec,
  SUMMARY_LENGTH_MAX_CHARACTERS,
  SUMMARY_LENGTH_TO_TOKENS,
} from './summary-lengths.js'

const HEADING_LENGTH_CHAR_THRESHOLD = 6000

export { SUMMARY_LENGTH_TO_TOKENS }

export type SummaryLengthTarget = SummaryLength | { maxCharacters: number }

export function pickSummaryLengthForCharacters(maxCharacters: number): SummaryLength {
  if (maxCharacters <= SUMMARY_LENGTH_MAX_CHARACTERS.short) return 'short'
  if (maxCharacters <= SUMMARY_LENGTH_MAX_CHARACTERS.medium) return 'medium'
  if (maxCharacters <= SUMMARY_LENGTH_MAX_CHARACTERS.long) return 'long'
  if (maxCharacters <= SUMMARY_LENGTH_MAX_CHARACTERS.xl) return 'xl'
  return 'xxl'
}

export function estimateMaxCompletionTokensForCharacters(maxCharacters: number): number {
  const estimate = Math.ceil(maxCharacters / 4)
  return Math.max(256, estimate)
}

const formatCount = (value: number): string => value.toLocaleString()

export type ShareContextEntry = {
  author: string
  handle?: string | null
  text: string
  likeCount?: number | null
  reshareCount?: number | null
  replyCount?: number | null
  timestamp?: string | null
}

export function buildLinkSummaryPrompt({
  url,
  title,
  siteName,
  description,
  content,
  truncated,
  hasTranscript,
  hasTranscriptTimestamps = false,
  slides,
  outputLanguage,
  summaryLength,
  shares,
  promptOverride,
  lengthInstruction,
  languageInstruction,
}: {
  url: string
  title: string | null
  siteName: string | null
  description: string | null
  content: string
  truncated: boolean
  hasTranscript: boolean
  hasTranscriptTimestamps?: boolean
  slides?: { count: number; text: string } | null
  summaryLength: SummaryLengthTarget
  outputLanguage?: OutputLanguage | null
  shares: ShareContextEntry[]
  promptOverride?: string | null
  lengthInstruction?: string | null
  languageInstruction?: string | null
}): string {
  const slidesText = slides?.text?.trim() ?? ''
  const contentWithSlides =
    slidesText.length > 0
      ? `${content}\n\nSlide timeline (transcript excerpts):\n${slidesText}`
      : content
  const contentCharacters = contentWithSlides.length
  const contextLines: string[] = [`Source URL: ${url}`]

  if (title) {
    contextLines.push(`Title: ${title}`)
  }

  if (siteName) {
    contextLines.push(`Site: ${siteName}`)
  }

  if (description) {
    contextLines.push(`Page description: ${description}`)
  }

  if (truncated) {
    contextLines.push('Note: Content truncated to the first portion available.')
  }

  const contextHeader = contextLines.join('\n')

  const audienceLine = hasTranscript
    ? 'You summarize online videos for curious Twitter users who want to know whether the clip is worth watching.'
    : 'You summarize online articles for curious Twitter users who want the gist before deciding to dive in.'

  const effectiveSummaryLength: SummaryLengthTarget =
    typeof summaryLength === 'string'
      ? summaryLength
      : contentCharacters > 0 && summaryLength.maxCharacters > contentCharacters
        ? { maxCharacters: contentCharacters }
        : summaryLength
  const preset =
    typeof effectiveSummaryLength === 'string'
      ? effectiveSummaryLength
      : pickSummaryLengthForCharacters(effectiveSummaryLength.maxCharacters)
  const directive = resolveSummaryLengthSpec(preset)
  const formattingLine = directive.formatting
  const presetLengthLine =
    typeof effectiveSummaryLength === 'string' ? formatPresetLengthGuidance(preset) : ''
  const needsHeadings =
    preset === 'xl' ||
    preset === 'xxl' ||
    (typeof effectiveSummaryLength !== 'string' &&
      effectiveSummaryLength.maxCharacters >= HEADING_LENGTH_CHAR_THRESHOLD)
  const headingInstruction =
    slides && slides.count > 0
      ? needsHeadings
        ? 'Use Markdown headings with the "### " prefix to break sections when helpful. Do not create a dedicated Slides section or list.'
        : 'Do not create a dedicated Slides section or list.'
      : needsHeadings
        ? 'Use Markdown headings with the "### " prefix to break sections. Include at least 3 headings and start with a heading. Do not use bold for headings.'
        : ''
  const maxCharactersLine =
    typeof effectiveSummaryLength === 'string'
      ? ''
      : `Target length: up to ${formatCount(effectiveSummaryLength.maxCharacters)} characters total (including Markdown and whitespace). Hard limit: do not exceed it.`
  const contentLengthLine =
    contentCharacters > 0
      ? `Extracted content length: ${formatCount(contentCharacters)} characters. Hard limit: never exceed this length. If the requested length is larger, do not pad—finish early rather than adding filler.`
      : ''

  const shareLines = shares.map((share) => {
    const handle = share.handle && share.handle.length > 0 ? `@${share.handle}` : share.author
    const metrics: string[] = []
    if (typeof share.likeCount === 'number' && share.likeCount > 0) {
      metrics.push(`${formatCount(share.likeCount)} likes`)
    }
    if (typeof share.reshareCount === 'number' && share.reshareCount > 0) {
      metrics.push(`${formatCount(share.reshareCount)} reshares`)
    }
    if (typeof share.replyCount === 'number' && share.replyCount > 0) {
      metrics.push(`${formatCount(share.replyCount)} replies`)
    }
    const metricsSuffix = metrics.length > 0 ? ` [${metrics.join(', ')}]` : ''
    const timestamp = share.timestamp ? ` (${share.timestamp})` : ''
    return `- ${handle}${timestamp}${metricsSuffix}: ${share.text}`
  })

  const shareGuidance =
    shares.length > 0
      ? 'You are also given quotes from people who recently shared this link. When these quotes contain substantive commentary, append a brief subsection titled "What sharers are saying" with one or two bullet points summarizing the key reactions. If they are generic reshares with no commentary, omit that subsection.'
      : 'You are not given any quotes from people who shared this link. Do not fabricate reactions or add a "What sharers are saying" subsection.'

  const shareBlock = shares.length > 0 ? `Tweets from sharers:\n${shareLines.join('\n')}` : ''
  const timestampInstruction =
    hasTranscriptTimestamps && !(slides && slides.count > 0)
      ? 'Add a "Key moments" section with 3-6 bullets (2-4 if the summary is short). Start each bullet with a [mm:ss] (or [hh:mm:ss]) timestamp from the transcript. Keep the rest of the summary readable and follow the normal formatting guidance; do not prepend timestamps outside the Key moments section. Do not invent timestamps or use ranges.'
      : ''
  const slideMarkers =
    slides && slides.count > 0
      ? Array.from({ length: slides.count }, (_, index) => `[slide:${index + 1}]`).join(' ')
      : ''
  const slideTemplate =
    slides && slides.count > 0
      ? [
          'Output template (copy and fill; keep markers on their own lines):',
          'Intro paragraph.',
          ...Array.from(
            { length: slides.count },
            (_, index) => `[slide:${index + 1}]\nText for this segment.`
          ),
        ].join('\n')
      : ''
  const slideInstruction =
    slides && slides.count > 0
      ? [
          'Start with a short intro paragraph (1-3 sentences) before the first slide tag.',
          'Write a continuous narrative that covers the whole video; do not switch to a bullet list.',
          'Slides are provided as transcript excerpts tied to time spans between adjacent slides.',
          'Formatting is strict: insert each slide marker on its own line where that slide should appear.',
          `Required markers (use each exactly once, in order): ${slideMarkers}`,
          'Use the exact lowercase tag format [slide:N]. Do not add a "### Slides" heading.',
          slideTemplate,
          'Do not add a separate Slides section or list.',
        ].join('\n')
      : ''
  const listGuidanceLine =
    'Use short paragraphs; use bullet lists only when they improve scanability; avoid rigid templates.'
  const quoteGuidanceLine =
    'Include 1-2 short exact excerpts (max 25 words each) formatted as Markdown italics using single asterisks when there is a strong, non-sponsor line. Use straight quotation marks (no curly) as needed. If no suitable line exists, omit excerpts. Never include ad/sponsor/boilerplate excerpts and do not mention them.'
  const sponsorInstruction =
    hasTranscript || (slides && slides.count > 0)
      ? 'Omit sponsor messages, ads, promos, and calls-to-action (including podcast ad reads), even if they appear in the transcript or slide timeline. Do not mention or acknowledge them, and do not say you skipped or ignored anything. Avoid sponsor/ad/promo language, brand names like Squarespace, or CTA phrases like discount code. Treat them as if they do not exist. If a slide segment is purely sponsor/ad content, leave that slide marker with no text.'
      : ''

  const baseInstructions = [
    'Hard rules: never mention sponsor/ads; use straight quotation marks only (no curly quotes).',
    'Apostrophes in contractions are OK.',
    audienceLine,
    sponsorInstruction,
    directive.guidance,
    formattingLine,
    headingInstruction,
    presetLengthLine,
    maxCharactersLine,
    contentLengthLine,
    formatOutputLanguageInstruction(outputLanguage ?? { kind: 'auto' }),
    'Keep the response compact by avoiding blank lines between sentences or list items; use only the single newlines required by the formatting instructions.',
    'Do not use emojis, disclaimers, or speculation.',
    'Write in direct, factual language.',
    'Format the answer in Markdown and obey the length-specific formatting above.',
    listGuidanceLine,
    quoteGuidanceLine,
    'Base everything strictly on the provided content and never invent details.',
    'Final check: remove any sponsor/ad references or mentions of skipping/ignoring content. Ensure excerpts (if any) are italicized and use only straight quotes.',
    timestampInstruction,
    shareGuidance,
    slideInstruction,
  ]
    .filter((line) => typeof line === 'string' && line.trim().length > 0)
    .join('\n')

  const instructions = buildInstructions({
    base: baseInstructions,
    overrides: { promptOverride, lengthInstruction, languageInstruction } satisfies PromptOverrides,
  })
  const context = [contextHeader, shareBlock]
    .filter((line) => typeof line === 'string' && line.trim().length > 0)
    .join('\n')

  return buildTaggedPrompt({
    instructions,
    context,
    content: contentWithSlides,
  })
}
