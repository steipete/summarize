import type { SummaryLengthTarget } from './link-summary.js'

export function buildFileSummaryPrompt({
  filename,
  mediaType,
  summaryLength,
}: {
  filename: string | null
  mediaType: string | null
  summaryLength: SummaryLengthTarget
}): string {
  const maxCharactersLine =
    typeof summaryLength === 'string'
      ? ''
      : `Target length: around ${summaryLength.maxCharacters.toLocaleString()} characters total (including Markdown and whitespace). This is a soft guideline; prioritize clarity.`

  const headerLines = [
    filename ? `Filename: ${filename}` : null,
    mediaType ? `Media type: ${mediaType}` : null,
  ].filter(Boolean)

  const prompt = `You summarize files for curious users. Summarize the attached file. Be factual and do not invent details. Format the answer in Markdown. Do not use emojis. ${maxCharactersLine}

${headerLines.length > 0 ? `${headerLines.join('\n')}\n\n` : ''}Return only the summary.`

  return prompt
}
