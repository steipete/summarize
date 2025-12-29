import { parseSseEvent, type SseMetaData } from '../../../../../src/shared/sse-events.js'
import { mergeStreamingChunk } from '../../../../../src/shared/streaming-merge.js'
import { parseSseStream } from '../../lib/sse'
import type { PanelPhase, RunStart } from './types'

export type StreamController = {
  start: (run: RunStart) => Promise<void>
  abort: () => void
  isStreaming: () => boolean
}

export type StreamControllerOptions = {
  getToken: () => Promise<string>
  onStatus: (text: string) => void
  onPhaseChange: (phase: PanelPhase) => void
  onMeta: (meta: SseMetaData) => void
  onError?: ((error: unknown) => string) | null
  fetchImpl?: typeof fetch
  // Summarize mode callbacks (optional for chat mode)
  onReset?: (() => void) | null
  onBaseTitle?: ((text: string) => void) | null
  onBaseSubtitle?: ((text: string) => void) | null
  onRememberUrl?: ((url: string) => void) | null
  onSummaryFromCache?: ((value: boolean | null) => void) | null
  onMetrics?: ((summary: string) => void) | null
  onRender?: ((markdown: string) => void) | null
  onSyncWithActiveTab?: (() => Promise<void>) | null
  // Chat mode callbacks (optional for summarize mode)
  onChunk?: ((accumulatedContent: string) => void) | null
  onDone?: (() => void) | null
  // Mode-specific options
  mode?: 'summarize' | 'chat'
  streamingStatusText?: string
}

export function createStreamController(options: StreamControllerOptions): StreamController {
  const {
    getToken,
    onStatus,
    onPhaseChange,
    onMeta,
    onError,
    fetchImpl,
    onReset,
    onBaseTitle,
    onBaseSubtitle,
    onRememberUrl,
    onSummaryFromCache,
    onMetrics,
    onRender,
    onSyncWithActiveTab,
    onChunk,
    onDone,
    mode = 'summarize',
    streamingStatusText,
  } = options
  let controller: AbortController | null = null
  let markdown = ''
  let chatContent = ''
  let renderQueued = 0
  let streamedAnyNonWhitespace = false
  let rememberedUrl = false
  let streaming = false

  const queueRender = () => {
    if (renderQueued || !onRender) return
    renderQueued = window.setTimeout(() => {
      renderQueued = 0
      onRender(markdown)
    }, 80)
  }

  const queueChunkUpdate = () => {
    if (renderQueued || !onChunk) return
    renderQueued = window.setTimeout(() => {
      renderQueued = 0
      onChunk(chatContent)
    }, 80)
  }

  const abort = () => {
    if (!controller) return
    controller.abort()
    controller = null
    if (streaming) {
      streaming = false
      onPhaseChange('idle')
    }
  }

  const start = async (run: RunStart) => {
    const token = (await getToken()).trim()
    if (!token) {
      onStatus('Setup required (missing token)')
      return
    }

    abort()
    const nextController = new AbortController()
    controller = nextController
    streaming = true
    streamedAnyNonWhitespace = false
    rememberedUrl = false
    markdown = ''
    chatContent = ''
    onPhaseChange('connecting')
    onSummaryFromCache?.(null)
    onReset?.()

    onBaseTitle?.(run.title || run.url)
    onBaseSubtitle?.('')
    onStatus('Connecting…')

    try {
      const res = await (fetchImpl ?? fetch)(
        `http://127.0.0.1:8787/v1/summarize/${run.id}/events`,
        {
          headers: { Authorization: `Bearer ${token}` },
          signal: nextController.signal,
        }
      )
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
      if (!res.body) throw new Error('Missing stream body')

      onStatus(streamingStatusText ?? (mode === 'chat' ? '' : 'Summarizing…'))
      onPhaseChange('streaming')

      for await (const msg of parseSseStream(res.body)) {
        if (nextController.signal.aborted) return

        const event = parseSseEvent(msg)
        if (!event) continue

        if (event.event === 'chunk') {
          if (mode === 'chat') {
            // Chat mode: accumulate raw chunks
            chatContent += event.data.text
            queueChunkUpdate()
          } else {
            // Summarize mode: merge streaming chunks
            const merged = mergeStreamingChunk(markdown, event.data.text).next
            if (merged !== markdown) {
              markdown = merged
              queueRender()
            }
          }

          if (!streamedAnyNonWhitespace && event.data.text.trim().length > 0) {
            streamedAnyNonWhitespace = true
            if (!rememberedUrl && onRememberUrl) {
              rememberedUrl = true
              onRememberUrl(run.url)
            }
          }
        } else if (event.event === 'meta') {
          onMeta(event.data)
          if (typeof event.data.summaryFromCache === 'boolean') {
            onSummaryFromCache?.(event.data.summaryFromCache)
          }
        } else if (event.event === 'status') {
          if (!streamedAnyNonWhitespace) onStatus(event.data.text)
        } else if (event.event === 'metrics') {
          onMetrics?.(event.data.summary)
        } else if (event.event === 'error') {
          throw new Error(event.data.message)
        } else if (event.event === 'done') {
          break
        }
      }

      // In summarize mode, require output; in chat mode, allow empty responses
      if (mode === 'summarize' && !streamedAnyNonWhitespace) {
        throw new Error('Model returned no output.')
      }

      onStatus('')
      onDone?.()
    } catch (err) {
      if (nextController.signal.aborted) return
      const message = onError ? onError(err) : err instanceof Error ? err.message : String(err)
      onStatus(`Error: ${message}`)
      onPhaseChange('error')
      onDone?.()
    } finally {
      if (controller === nextController) {
        streaming = false
        if (!nextController.signal.aborted) {
          onPhaseChange('idle')
        }
        await onSyncWithActiveTab?.()
      }
    }
  }

  return {
    start,
    abort,
    isStreaming: () => streaming,
  }
}
