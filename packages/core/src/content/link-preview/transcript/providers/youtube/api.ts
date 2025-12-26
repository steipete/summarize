import { fetchWithTimeout } from '../../../fetch-with-timeout.js'
import { extractYoutubeBootstrapConfig, isRecord } from '../../utils.js'

const REQUEST_HEADERS: Record<string, string> = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
  Accept:
    'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Cache-Control': 'no-cache',
  Pragma: 'no-cache',
}

export interface YoutubeTranscriptConfig {
  apiKey: string
  context: Record<string, unknown>
  params: string
  visitorData?: string | null
  clientName?: string | null
  clientVersion?: string | null
  pageCl?: number | null
  pageLabel?: string | null
}

type YoutubeBootstrapConfig = Record<string, unknown> & {
  INNERTUBE_API_KEY?: unknown
  INNERTUBE_CONTEXT?: unknown
  INNERTUBE_CLIENT_VERSION?: unknown
  INNERTUBE_CONTEXT_CLIENT_NAME?: unknown
  INNERTUBE_CONTEXT_CLIENT_VERSION?: unknown
  VISITOR_DATA?: unknown
  PAGE_CL?: unknown
  PAGE_BUILD_LABEL?: unknown
}

type TranscriptRunRecord = Record<string, unknown> & { text?: unknown }
const GET_TRANSCRIPT_ENDPOINT_REGEX = /"getTranscriptEndpoint":\{"params":"([^"]+)"\}/

export const extractYoutubeiTranscriptConfig = (html: string): YoutubeTranscriptConfig | null => {
  try {
    const bootstrapConfig = extractYoutubeBootstrapConfig(html)
    if (!bootstrapConfig) {
      return null
    }

    const parametersMatch = html.match(GET_TRANSCRIPT_ENDPOINT_REGEX)
    if (!parametersMatch) {
      return null
    }

    const [, parameters] = parametersMatch
    if (!parameters) {
      return null
    }

    const typedBootstrap = bootstrapConfig as YoutubeBootstrapConfig
    const apiKeyCandidate = typedBootstrap.INNERTUBE_API_KEY
    const apiKey = typeof apiKeyCandidate === 'string' ? apiKeyCandidate : null
    const contextCandidate = typedBootstrap.INNERTUBE_CONTEXT
    const context = isRecord(contextCandidate) ? contextCandidate : null

    if (!(apiKey && context)) {
      return null
    }

    const visitorDataCandidate = typedBootstrap.VISITOR_DATA
    const visitorDataFromBootstrap =
      typeof visitorDataCandidate === 'string' ? visitorDataCandidate : null
    const contextClientCandidate = (context as Record<string, unknown>).client
    const contextClient = isRecord(contextClientCandidate) ? contextClientCandidate : null
    const visitorDataFromContext =
      typeof contextClient?.visitorData === 'string' ? (contextClient.visitorData as string) : null
    const visitorData = visitorDataFromBootstrap ?? visitorDataFromContext
    const clientNameCandidate = typedBootstrap.INNERTUBE_CONTEXT_CLIENT_NAME
    const clientName =
      typeof clientNameCandidate === 'number'
        ? String(clientNameCandidate)
        : typeof clientNameCandidate === 'string'
          ? clientNameCandidate
          : null
    const clientVersionCandidate = typedBootstrap.INNERTUBE_CONTEXT_CLIENT_VERSION
    const clientVersion = typeof clientVersionCandidate === 'string' ? clientVersionCandidate : null
    const pageClCandidate = typedBootstrap.PAGE_CL
    const pageCl = typeof pageClCandidate === 'number' ? pageClCandidate : null
    const pageLabelCandidate = typedBootstrap.PAGE_BUILD_LABEL
    const pageLabel = typeof pageLabelCandidate === 'string' ? pageLabelCandidate : null

    return {
      apiKey,
      context,
      params: parameters,
      visitorData,
      clientName,
      clientVersion,
      pageCl,
      pageLabel,
    }
  } catch {
    return null
  }
}

export const fetchTranscriptFromTranscriptEndpoint = async (
  fetchImpl: typeof fetch,
  {
    config,
    originalUrl,
  }: {
    config: YoutubeTranscriptConfig
    originalUrl: string
  }
): Promise<string | null> => {
  type YoutubeClientContext = Record<string, unknown> & { client?: unknown }
  const contextRecord = config.context as YoutubeClientContext
  const existingClient = isRecord(contextRecord.client)
    ? (contextRecord.client as Record<string, unknown>)
    : {}

  const payload = {
    context: {
      ...contextRecord,
      client: {
        ...existingClient,
        originalUrl,
      },
    },
    params: config.params,
  }

  try {
    const userAgent =
      REQUEST_HEADERS['User-Agent'] ??
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36'
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'User-Agent': userAgent,
      Accept: 'application/json',
      Origin: 'https://www.youtube.com',
      Referer: originalUrl,
      'X-Goog-AuthUser': '0',
      'X-Youtube-Bootstrap-Logged-In': 'false',
    }

    if (config.clientName) {
      headers['X-Youtube-Client-Name'] = config.clientName
    }
    if (config.clientVersion) {
      headers['X-Youtube-Client-Version'] = config.clientVersion
    }
    if (config.visitorData) {
      headers['X-Goog-Visitor-Id'] = config.visitorData
    }
    if (typeof config.pageCl === 'number' && Number.isFinite(config.pageCl)) {
      headers['X-Youtube-Page-CL'] = String(config.pageCl)
    }
    if (config.pageLabel) {
      headers['X-Youtube-Page-Label'] = config.pageLabel
    }

    const response = await fetchWithTimeout(
      fetchImpl,
      `https://www.youtube.com/youtubei/v1/get_transcript?key=${config.apiKey}`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
      }
    )

    if (!response.ok) {
      return null
    }

    return extractTranscriptFromTranscriptEndpoint(await response.json())
  } catch {
    return null
  }
}

// Type-safe helper functions for YouTube API parsing
function getNestedProperty(object: unknown, path: string[]): unknown {
  let current: unknown = object
  for (const key of path) {
    if (!(isRecord(current) && key in current)) {
      return null
    }
    current = current[key]
  }
  return current
}

function getArrayProperty(object: unknown, path: string[]): unknown[] | null {
  const value = getNestedProperty(object, path)
  return Array.isArray(value) ? value : null
}

export const extractTranscriptFromTranscriptEndpoint = (data: unknown): string | null => {
  if (!isRecord(data)) {
    return null
  }

  const actions = getArrayProperty(data, ['actions'])
  if (!actions || actions.length === 0) {
    return null
  }

  const updatePanel = getNestedProperty(actions[0], ['updateEngagementPanelAction'])
  if (!updatePanel) {
    return null
  }

  const transcriptContent = getNestedProperty(updatePanel, ['content'])
  if (!transcriptContent) {
    return null
  }

  const searchPanel = getNestedProperty(transcriptContent, ['transcriptRenderer'])
  if (!searchPanel) {
    return null
  }

  const segmentList = getNestedProperty(searchPanel, ['content'])
  if (!segmentList) {
    return null
  }

  const listRenderer = getNestedProperty(segmentList, ['transcriptSearchPanelRenderer'])
  if (!listRenderer) {
    return null
  }

  const body = getNestedProperty(listRenderer, ['body'])
  if (!body) {
    return null
  }

  const segmentBody = getNestedProperty(body, ['transcriptSegmentListRenderer'])
  if (!segmentBody) {
    return null
  }

  const segments = getArrayProperty(segmentBody, ['initialSegments'])
  if (!segments || segments.length === 0) {
    return null
  }

  const lines: string[] = []
  for (const segment of segments) {
    const renderer = getNestedProperty(segment, ['transcriptSegmentRenderer'])
    if (!renderer) {
      continue
    }

    const snippet = getNestedProperty(renderer, ['snippet'])
    if (!snippet) {
      continue
    }

    const runs = getArrayProperty(snippet, ['runs'])
    if (!runs) {
      continue
    }
    const text = runs
      .map((value) => {
        if (!isRecord(value)) {
          return ''
        }
        const runRecord = value as TranscriptRunRecord
        return typeof runRecord.text === 'string' ? runRecord.text : ''
      })
      .join('')
      .trim()
    if (text.length > 0) {
      lines.push(text)
    }
  }

  if (lines.length === 0) {
    return null
  }

  return lines.join('\n')
}

export const extractYoutubeiBootstrap = (
  html: string
): {
  apiKey: string | null
  context: Record<string, unknown>
  clientVersion: string | null
  clientName: string | null
  visitorData: string | null
  pageCl: number | null
  pageLabel: string | null
  xsrfToken: string | null
} | null => {
  try {
    const bootstrapConfig = extractYoutubeBootstrapConfig(html)
    if (!bootstrapConfig) {
      return null
    }
    const typedBootstrap = bootstrapConfig as YoutubeBootstrapConfig
    const apiKeyCandidate = typedBootstrap.INNERTUBE_API_KEY
    const apiKey = typeof apiKeyCandidate === 'string' ? apiKeyCandidate : null
    const contextCandidate = typedBootstrap.INNERTUBE_CONTEXT
    const context = isRecord(contextCandidate) ? contextCandidate : null
    const clientVersionCandidate = typedBootstrap.INNERTUBE_CLIENT_VERSION
    const clientVersion = typeof clientVersionCandidate === 'string' ? clientVersionCandidate : null
    const clientNameCandidate = typedBootstrap.INNERTUBE_CONTEXT_CLIENT_NAME
    const clientName =
      typeof clientNameCandidate === 'number'
        ? String(clientNameCandidate)
        : typeof clientNameCandidate === 'string'
          ? clientNameCandidate
          : null
    const contextClientCandidate = (context as Record<string, unknown>).client
    const contextClient = isRecord(contextClientCandidate) ? contextClientCandidate : null
    const visitorDataCandidate = contextClient?.visitorData
    const visitorData = typeof visitorDataCandidate === 'string' ? visitorDataCandidate : null
    const pageClCandidate = typedBootstrap.PAGE_CL
    const pageCl = typeof pageClCandidate === 'number' ? pageClCandidate : null
    const pageLabelCandidate = typedBootstrap.PAGE_BUILD_LABEL
    const pageLabel = typeof pageLabelCandidate === 'string' ? pageLabelCandidate : null
    const xsrfCandidate = (bootstrapConfig as Record<string, unknown>).XSRF_TOKEN
    const xsrfToken = typeof xsrfCandidate === 'string' ? xsrfCandidate : null
    if (!context) {
      return null
    }
    return {
      apiKey,
      context,
      clientVersion,
      clientName,
      visitorData,
      pageCl,
      pageLabel,
      xsrfToken,
    }
  } catch {
    return null
  }
}
