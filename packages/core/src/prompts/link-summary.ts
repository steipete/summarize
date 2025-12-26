import type { OutputLanguage } from '../language.js'
import { formatOutputLanguageInstruction } from '../language.js'
import type { SummaryLength } from '../shared/contracts.js'

const SUMMARY_LENGTH_DIRECTIVES: Record<SummaryLength, { guidance: string; formatting: string }> = {
  short: {
    guidance:
      'Write a tight paragraph (2–3 sentences) that delivers the primary claim plus one high-signal supporting detail.',
    formatting: 'Output a single paragraph with normal sentences; avoid headings or bullet lists.',
  },
  medium: {
    guidance:
      'Write two short paragraphs covering the core claim in the first paragraph and the most important supporting evidence, data points, or implications in the second.',
    formatting:
      'Each paragraph should contain 2–3 sentences. Separate paragraphs with a blank line. Do not use bullet lists or headings.',
  },
  long: {
    guidance:
      'Write three paragraphs: (1) summarize the claim and scope, (2) walk through the major supporting arguments or events, (3) explain implications, risks, or recommended next steps.',
    formatting:
      'Keep paragraphs balanced (3–4 sentences each) and separate them with single blank lines. No bullet lists or headings.',
  },
  xl: {
    guidance:
      'Produce a structured Markdown outline with short section headings (“Overview”, “Key Evidence”, “Implications”, “Next Steps”) followed by 2–3 bullet points under each heading. Surface quantitative details, quotes, or contrasting views when available.',
    formatting:
      'Use level-3 Markdown headings (###) for each section followed by bullet lists. Bullets may span 1–2 sentences and can exceed 20 words when necessary.',
  },
  xxl: {
    guidance:
      'Produce a comprehensive Markdown report: start with a short executive summary paragraph, then add sections for Background, Detailed Findings, Implications, and Open Questions. Within sections, use bullet lists or short paragraphs to cover nuanced context, statistics, quotes, counterpoints, and recommended follow-up actions.',
    formatting:
      'Use Markdown headings (###) for each section, combine paragraphs and bullet lists as needed, and ensure the overall response is substantial (multiple paragraphs and bullets totalling several hundred words) while remaining factual.',
  },
}

export const SUMMARY_LENGTH_TO_TOKENS: Record<SummaryLength, number> = {
  short: 768,
  medium: 1536,
  long: 3072,
  xl: 6144,
  xxl: 12288,
}

export type SummaryLengthTarget = SummaryLength | { maxCharacters: number }

export function pickSummaryLengthForCharacters(maxCharacters: number): SummaryLength {
  if (maxCharacters <= 1200) return 'short'
  if (maxCharacters <= 2500) return 'medium'
  if (maxCharacters <= 6000) return 'long'
  if (maxCharacters <= 14000) return 'xl'
  return 'xxl'
}

export function estimateMaxCompletionTokensForCharacters(maxCharacters: number): number {
  const estimate = Math.ceil(maxCharacters / 4)
  return Math.max(256, estimate)
}

const resolveSummaryDirective = (
  length: SummaryLength
): (typeof SUMMARY_LENGTH_DIRECTIVES)[SummaryLength] =>
  // SummaryLength is a contracts-enforced enum in all call sites; suppress generic injection warning.
  // eslint-disable-next-line security/detect-object-injection
  SUMMARY_LENGTH_DIRECTIVES[length]

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
  outputLanguage,
  summaryLength,
  shares,
}: {
  url: string
  title: string | null
  siteName: string | null
  description: string | null
  content: string
  truncated: boolean
  hasTranscript: boolean
  summaryLength: SummaryLengthTarget
  outputLanguage?: OutputLanguage | null
  shares: ShareContextEntry[]
}): string {
  const contentCharacters = content.length
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
  const directive = resolveSummaryDirective(preset)
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

  const sharesBlock = shares.length > 0 ? `Tweets from sharers:\n${shareLines.join('\n')}\n\n` : ''
  const languageInstruction = formatOutputLanguageInstruction(outputLanguage ?? { kind: 'auto' })

  return `${audienceLine} ${directive.guidance} ${directive.formatting} ${maxCharactersLine} ${contentLengthLine} ${languageInstruction} Keep the response compact by avoiding blank lines between sentences or list items; use only the single newlines required by the formatting instructions. Do not use emojis, disclaimers, or speculation. Write in direct, factual language. Format the answer in Markdown and obey the length-specific formatting above. Base everything strictly on the provided content and never invent details. ${shareGuidance}

${contextHeader}

${sharesBlock}Extracted content:
"""
${content}
"""
`
}
