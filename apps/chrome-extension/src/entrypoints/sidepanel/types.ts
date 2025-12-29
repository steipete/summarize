export type UiState = {
  panelOpen: boolean
  daemon: { ok: boolean; authed: boolean; error?: string }
  tab: { url: string | null; title: string | null }
  settings: { autoSummarize: boolean; model: string; length: string; tokenPresent: boolean }
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

export type ChatMessage = {
  id: string
  role: 'user' | 'assistant'
  content: string
  timestamp: number
}

export type PanelState = {
  ui: UiState | null
  currentSource: { url: string; title: string | null } | null
  lastMeta: { inputSummary: string | null; model: string | null; modelLabel: string | null }
  summaryFromCache: boolean | null
  phase: PanelPhase
  error: string | null
  // Chat state
  inChatMode: boolean
  chatMessages: ChatMessage[]
  chatStreaming: boolean
  chatTranscript: string | null
}
