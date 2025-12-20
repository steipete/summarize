import type { ConvertHtmlToMarkdown } from '../content/link-preview/deps.js'
import type { LlmTokenUsage } from './generate-text.js'
import { generateTextWithModelId } from './generate-text.js'

const MAX_HTML_INPUT_CHARACTERS = 200_000

function buildHtmlToMarkdownPrompt({
  url,
  title,
  siteName,
  html,
}: {
  url: string
  title: string | null
  siteName: string | null
  html: string
}): { system: string; prompt: string } {
  const system = `You convert HTML into clean GitHub-Flavored Markdown.

Rules:
- Output ONLY Markdown (no JSON, no explanations, no code fences).
- Keep headings, lists, code blocks, blockquotes.
- Preserve links as Markdown links when possible.
- Remove navigation, cookie banners, footers, and unrelated page chrome.
- Do not invent content.`

  const prompt = `URL: ${url}
Site: ${siteName ?? 'unknown'}
Title: ${title ?? 'unknown'}

HTML:
"""
${html}
"""
`

  return { system, prompt }
}

export function createHtmlToMarkdownConverter({
  modelId,
  xaiApiKey,
  googleApiKey,
  openaiApiKey,
  anthropicApiKey,
  openrouterApiKey,
  fetchImpl,
  onUsage,
}: {
  modelId: string
  xaiApiKey: string | null
  googleApiKey: string | null
  openaiApiKey: string | null
  fetchImpl: typeof fetch
  anthropicApiKey: string | null
  openrouterApiKey: string | null
  onUsage?: (usage: {
    model: string
    provider: 'xai' | 'openai' | 'google' | 'anthropic'
    usage: LlmTokenUsage | null
  }) => void
}): ConvertHtmlToMarkdown {
  return async ({ url, html, title, siteName, timeoutMs }) => {
    const trimmedHtml =
      html.length > MAX_HTML_INPUT_CHARACTERS ? html.slice(0, MAX_HTML_INPUT_CHARACTERS) : html
    const { system, prompt } = buildHtmlToMarkdownPrompt({
      url,
      title,
      siteName,
      html: trimmedHtml,
    })

    const result = await generateTextWithModelId({
      modelId,
      apiKeys: { xaiApiKey, googleApiKey, openaiApiKey, anthropicApiKey, openrouterApiKey },
      system,
      prompt,
      timeoutMs,
      fetchImpl,
    })
    onUsage?.({ model: result.canonicalModelId, provider: result.provider, usage: result.usage })
    return result.text
  }
}
