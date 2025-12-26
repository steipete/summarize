import type { FirecrawlScrapeResult, ScrapeWithFirecrawl } from '@steipete/summarize-core/content'

type FirecrawlResponse = {
  success: boolean
  data?: {
    markdown?: string | null
    html?: string | null
    metadata?: Record<string, unknown> | null
  } | null
  error?: string | null
}

export function createFirecrawlScraper({
  apiKey,
  fetchImpl,
}: {
  apiKey: string
  fetchImpl: typeof fetch
}): ScrapeWithFirecrawl {
  return async (
    url: string,
    options?: { timeoutMs?: number }
  ): Promise<FirecrawlScrapeResult | null> => {
    const controller = new AbortController()
    const timeoutMs = options?.timeoutMs
    const hasTimeout = typeof timeoutMs === 'number' && Number.isFinite(timeoutMs) && timeoutMs > 0
    const timeout = hasTimeout ? setTimeout(() => controller.abort(), timeoutMs) : null

    try {
      const response = await fetchImpl('https://api.firecrawl.dev/v1/scrape', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        signal: controller.signal,
        body: JSON.stringify({
          url,
          formats: ['markdown', 'html'],
          onlyMainContent: true,
          proxy: 'auto',
          maxAge: 0,
        }),
      })

      const payload = (await response.json().catch(() => null)) as FirecrawlResponse | null

      if (!response.ok) {
        const message = payload?.error ? `: ${payload.error}` : ''
        throw new Error(`Firecrawl request failed (${response.status})${message}`)
      }

      if (!payload?.success) {
        throw new Error(payload?.error ?? 'Firecrawl response was not successful')
      }

      const data = payload.data
      const markdown = data?.markdown ?? null
      if (typeof markdown !== 'string' || markdown.trim().length === 0) {
        return null
      }

      return {
        markdown,
        html: typeof data?.html === 'string' ? data.html : null,
        metadata: data?.metadata ?? null,
      }
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        throw new Error('Firecrawl request timed out')
      }
      throw error
    } finally {
      if (timeout) clearTimeout(timeout)
    }
  }
}
