import type { Message } from '@mariozechner/pi-ai'
import type { SseSlidesData } from '../../../../../src/shared/sse-events.js'

export type UiState = {
  panelOpen: boolean
  daemon: { ok: boolean; authed: boolean; error?: string }
  tab: { id: number | null; url: string | null; title: string | null }
  media: { hasVideo: boolean; hasAudio: boolean; hasCaptions: boolean } | null
  stats: { pageWords: number | null; videoDurationSeconds: number | null }
  settings: {
    autoSummarize: boolean
    hoverSummaries: boolean
    chatEnabled: boolean
    automationEnabled: boolean
    slidesEnabled: boolean
    slidesLayout: 'strip' | 'gallery'
    fontSize: number
    lineHeight: number
    model: string
    length: string
    tokenPresent: boolean
  }
  status: string
}

export type RunStart = {
  id: string
  url: string
  title: string | null
  model: string
  reason: string
}

export type PanelPhase = 'idle' | 'setup' | 'connecting' | 'streaming' | 'error'

export type ChatMessage = Message & { id: string }

export type PanelState = {
  ui: UiState | null
  runId: string | null
  currentSource: { url: string; title: string | null } | null
  lastMeta: { inputSummary: string | null; model: string | null; modelLabel: string | null }
  summaryMarkdown: string | null
  summaryFromCache: boolean | null
  slides: SseSlidesData | null
  phase: PanelPhase
  error: string | null
  chatStreaming: boolean
}
