import type { AssistantMessage, Message, ToolCall, ToolResultMessage } from '@mariozechner/pi-ai'
import { extractYouTubeVideoId, shouldPreferUrlMode } from '@steipete/summarize-core/content/url'
import { SUMMARY_LENGTH_SPECS } from '@steipete/summarize-core/prompts'
import MarkdownIt from 'markdown-it'

import { parseSseEvent, type SseSlidesData } from '../../../../../src/shared/sse-events.js'
import { listSkills } from '../../automation/skills-store'
import { executeToolCall, getAutomationToolNames } from '../../automation/tools'
import { readPresetOrCustomValue } from '../../lib/combo'
import { buildIdleSubtitle } from '../../lib/header'
import { buildMetricsParts, buildMetricsTokens } from '../../lib/metrics'
import { defaultSettings, loadSettings, patchSettings, type SlidesLayout } from '../../lib/settings'
import { parseSseStream } from '../../lib/sse'
import { applyTheme } from '../../lib/theme'
import { generateToken } from '../../lib/token'
import { mountCheckbox } from '../../ui/zag-checkbox'
import { ChatController } from './chat-controller'
import { type ChatHistoryLimits, compactChatHistory } from './chat-state'
import { createErrorController } from './error-controller'
import { createHeaderController } from './header-controller'
import { createPanelCacheController, type PanelCachePayload } from './panel-cache'
import { mountSidepanelLengthPicker, mountSidepanelPickers, mountSummarizeControl } from './pickers'
import { createSlideImageLoader, normalizeSlideImageUrl } from './slide-images'
import { createSlidesHydrator } from './slides-hydrator'
import { createStreamController } from './stream-controller'
import type { ChatMessage, PanelPhase, PanelState, RunStart, UiState } from './types'

type PanelToBg =
  | { type: 'panel:ready' }
  | { type: 'panel:summarize'; refresh?: boolean; inputMode?: 'page' | 'video' }
  | {
      type: 'panel:agent'
      requestId: string
      messages: Message[]
      tools: string[]
      summary?: string | null
    }
  | {
      type: 'panel:chat-history'
      requestId: string
      summary?: string | null
    }
  | { type: 'panel:seek'; seconds: number }
  | { type: 'panel:ping' }
  | { type: 'panel:closed' }
  | { type: 'panel:rememberUrl'; url: string }
  | { type: 'panel:setAuto'; value: boolean }
  | { type: 'panel:setLength'; value: string }
  | { type: 'panel:slides-context'; requestId: string }
  | { type: 'panel:cache'; cache: PanelCachePayload }
  | { type: 'panel:get-cache'; requestId: string; tabId: number; url: string }
  | { type: 'panel:openOptions' }

type BgToPanel =
  | { type: 'ui:state'; state: UiState }
  | { type: 'ui:status'; status: string }
  | { type: 'run:start'; run: RunStart }
  | { type: 'run:error'; message: string }
  | { type: 'slides:run'; ok: boolean; runId?: string; url?: string; error?: string }
  | { type: 'chat:history'; requestId: string; ok: boolean; messages?: Message[]; error?: string }
  | { type: 'agent:chunk'; requestId: string; text: string }
  | {
      type: 'agent:response'
      requestId: string
      ok: boolean
      assistant?: AssistantMessage
      error?: string
    }
  | {
      type: 'slides:context'
      requestId: string
      ok: boolean
      transcriptTimedText?: string | null
      error?: string
    }
  | { type: 'ui:cache'; requestId: string; ok: boolean; cache?: PanelCachePayload }

let panelPort: chrome.runtime.Port | null = null
let panelPortConnecting: Promise<chrome.runtime.Port | null> | null = null
let panelWindowId: number | null = null
let currentRunTabId: number | null = null

function getCurrentWindowId(): Promise<number | null> {
  return new Promise((resolve) => {
    chrome.windows.getCurrent((window) => {
      resolve(typeof window?.id === 'number' ? window.id : null)
    })
  })
}

async function ensurePanelPort(): Promise<chrome.runtime.Port | null> {
  if (panelPort) return panelPort
  if (panelPortConnecting) return panelPortConnecting
  panelPortConnecting = (async () => {
    const windowId = panelWindowId ?? (await getCurrentWindowId())
    panelWindowId = windowId
    if (typeof windowId !== 'number') return null
    const port = chrome.runtime.connect({ name: `sidepanel:${windowId}` })
    panelPort = port
    ;(window as unknown as { __summarizePanelPort?: chrome.runtime.Port }).__summarizePanelPort =
      port
    port.onMessage.addListener((msg) => {
      handleBgMessage(msg as BgToPanel)
    })
    port.onDisconnect.addListener(() => {
      if (panelPort !== port) return
      panelPort = null
      panelPortConnecting = null
      ;(window as unknown as { __summarizePanelPort?: chrome.runtime.Port }).__summarizePanelPort =
        undefined
    })
    return port
  })()
  const resolved = await panelPortConnecting
  if (!resolved) panelPortConnecting = null
  return resolved
}

function byId<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id)
  if (!el) throw new Error(`Missing #${id}`)
  return el as T
}

const subtitleEl = byId<HTMLDivElement>('subtitle')
const titleEl = byId<HTMLDivElement>('title')
const headerEl = document.querySelector('header') as HTMLElement
if (!headerEl) throw new Error('Missing <header>')
const progressFillEl = byId<HTMLDivElement>('progressFill')
const drawerEl = byId<HTMLElement>('drawer')
const setupEl = byId<HTMLDivElement>('setup')
const errorEl = byId<HTMLDivElement>('error')
const errorMessageEl = byId<HTMLParagraphElement>('errorMessage')
const errorRetryBtn = byId<HTMLButtonElement>('errorRetry')
const errorLogsBtn = byId<HTMLButtonElement>('errorLogs')
const slideNoticeEl = byId<HTMLDivElement>('slideNotice')
const renderEl = byId<HTMLElement>('render')
const renderSlidesHostEl = document.createElement('div')
renderSlidesHostEl.className = 'render__slidesHost'
const renderMarkdownHostEl = document.createElement('div')
renderMarkdownHostEl.className = 'render__markdownHost'
renderEl.append(renderSlidesHostEl, renderMarkdownHostEl)
const mainEl = document.querySelector('main') as HTMLElement
if (!mainEl) throw new Error('Missing <main>')
const metricsEl = byId<HTMLDivElement>('metrics')
const metricsHomeEl = byId<HTMLDivElement>('metricsHome')
const chatMetricsSlotEl = byId<HTMLDivElement>('chatMetricsSlot')
const chatDockEl = byId<HTMLDivElement>('chatDock')
const slideImageLoader = createSlideImageLoader()

const summarizeControlRoot = byId<HTMLElement>('summarizeControlRoot')
const drawerToggleBtn = byId<HTMLButtonElement>('drawerToggle')
const refreshBtn = byId<HTMLButtonElement>('refresh')
const clearBtn = byId<HTMLButtonElement>('clear')
const advancedBtn = byId<HTMLButtonElement>('advanced')
const autoToggleRoot = byId<HTMLDivElement>('autoToggle')
const lengthRoot = byId<HTMLDivElement>('lengthRoot')
const pickersRoot = byId<HTMLDivElement>('pickersRoot')
const sizeSmBtn = byId<HTMLButtonElement>('sizeSm')
const sizeLgBtn = byId<HTMLButtonElement>('sizeLg')
const lineTightBtn = byId<HTMLButtonElement>('lineTight')
const lineLooseBtn = byId<HTMLButtonElement>('lineLoose')
const advancedSettingsEl = byId<HTMLDetailsElement>('advancedSettings')
const modelPresetEl = byId<HTMLSelectElement>('modelPreset')
const modelCustomEl = byId<HTMLInputElement>('modelCustom')
const modelRefreshBtn = byId<HTMLButtonElement>('modelRefresh')
const modelStatusEl = byId<HTMLDivElement>('modelStatus')
const modelRowEl = byId<HTMLDivElement>('modelRow')
const slidesLayoutEl = byId<HTMLSelectElement>('slidesLayout')

const chatContainerEl = byId<HTMLElement>('chatContainer')
const chatMessagesEl = byId<HTMLDivElement>('chatMessages')
const chatInputEl = byId<HTMLTextAreaElement>('chatInput')
const chatSendBtn = byId<HTMLButtonElement>('chatSend')
const chatContextStatusEl = byId<HTMLDivElement>('chatContextStatus')
const automationNoticeEl = byId<HTMLDivElement>('automationNotice')
const automationNoticeTitleEl = byId<HTMLDivElement>('automationNoticeTitle')
const automationNoticeMessageEl = byId<HTMLDivElement>('automationNoticeMessage')
const automationNoticeActionBtn = byId<HTMLButtonElement>('automationNoticeAction')
const chatJumpBtn = byId<HTMLButtonElement>('chatJump')
const chatQueueEl = byId<HTMLDivElement>('chatQueue')
const inlineErrorEl = byId<HTMLDivElement>('inlineError')
const inlineErrorMessageEl = byId<HTMLDivElement>('inlineErrorMessage')
const inlineErrorRetryBtn = byId<HTMLButtonElement>('inlineErrorRetry')
const inlineErrorLogsBtn = byId<HTMLButtonElement>('inlineErrorLogs')
const inlineErrorCloseBtn = byId<HTMLButtonElement>('inlineErrorClose')

const md = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: false,
})

const slideTagPattern = /^\[slide:(\d+)\]/i
const slideTagPlugin = (markdown: MarkdownIt) => {
  markdown.inline.ruler.before('emphasis', 'slide_tag', (state, silent) => {
    const match = state.src.slice(state.pos).match(slideTagPattern)
    if (!match) return false
    if (!silent) {
      const token = state.push('slide_tag', 'span', 0)
      token.meta = { index: Number(match[1]) }
    }
    state.pos += match[0].length
    return true
  })
  markdown.renderer.rules.slide_tag = (tokens, idx) => {
    const index = tokens[idx]?.meta?.index
    if (!Number.isFinite(index)) return ''
    return `<span class="slideInline" data-slide-index="${index}"></span>`
  }
}

md.use(slideTagPlugin)

const panelState: PanelState = {
  ui: null,
  runId: null,
  slidesRunId: null,
  currentSource: null,
  lastMeta: { inputSummary: null, model: null, modelLabel: null },
  summaryMarkdown: null,
  summaryFromCache: null,
  slides: null,
  phase: 'idle',
  error: null,
  chatStreaming: false,
}
let drawerAnimation: Animation | null = null
let autoValue = false
let chatEnabledValue = defaultSettings.chatEnabled
let automationEnabledValue = defaultSettings.automationEnabled
let slidesEnabledValue = defaultSettings.slidesEnabled
let slidesParallelValue = defaultSettings.slidesParallel
let autoKickTimer = 0

const MAX_CHAT_MESSAGES = 1000
const MAX_CHAT_CHARACTERS = 160_000
const MAX_CHAT_QUEUE = 10
const chatLimits: ChatHistoryLimits = {
  maxMessages: MAX_CHAT_MESSAGES,
  maxChars: MAX_CHAT_CHARACTERS,
}
type ChatQueueItem = {
  id: string
  text: string
  createdAt: number
}
let chatQueue: ChatQueueItem[] = []
const chatHistoryCache = new Map<number, ChatMessage[]>()
let chatHistoryLoadId = 0
let activeTabId: number | null = null
let activeTabUrl: string | null = null
let lastStreamError: string | null = null
let lastAction: 'summarize' | 'chat' | null = null
let abortAgentRequested = false
let lastNavigationMessageUrl: string | null = null
let inputMode: 'page' | 'video' = 'page'
let inputModeOverride: 'page' | 'video' | null = null
let mediaAvailable = false
let preserveChatOnNextReset = false
let summarizeVideoLabel = 'Video'
let summarizePageWords: number | null = null
let summarizeVideoDurationSeconds: number | null = null

type SlideTextMode = 'transcript' | 'ocr'
type TranscriptSegment = { startSeconds: number; text: string }
let slidesBusy = false
let slidesExpanded = true
let slidesTextMode: SlideTextMode = 'transcript'
let slidesTextToggleVisible = false
let slidesTranscriptSegments: TranscriptSegment[] = []
let slidesTranscriptTimedText: string | null = null
let slidesTranscriptAvailable = false
let slidesOcrAvailable = false
let slidesLayoutValue: SlidesLayout = defaultSettings.slidesLayout
let slideDescriptions = new Map<number, string>()
let slideSummaryByIndex = new Map<number, string>()
let slideTitleByIndex = new Map<number, string>()
let slidesContextRequestId = 0
let slidesContextPending = false
let slidesContextUrl: string | null = null
let pendingRunForPlannedSlides: RunStart | null = null

const AGENT_NAV_TTL_MS = 20_000
type AgentNavigation = { url: string; tabId: number | null; at: number }
let lastAgentNavigation: AgentNavigation | null = null
let pendingPreserveChatForUrl: { url: string; at: number } | null = null

const chatController = new ChatController({
  messagesEl: chatMessagesEl,
  inputEl: chatInputEl,
  sendBtn: chatSendBtn,
  contextEl: chatContextStatusEl,
  markdown: md,
  limits: chatLimits,
  scrollToBottom: () => scrollToBottom(),
  onNewContent: () => {
    renderInlineSlides(chatMessagesEl)
  },
})

type AutomationNoticeAction = 'extensions' | 'options'

function hideAutomationNotice() {
  automationNoticeEl.classList.add('hidden')
}

function showSlideNotice(message: string) {
  slideNoticeEl.textContent = message
  slideNoticeEl.classList.remove('hidden')
  headerController.updateHeaderOffset()
}

function hideSlideNotice() {
  slideNoticeEl.classList.add('hidden')
  slideNoticeEl.textContent = ''
  headerController.updateHeaderOffset()
}

function stopSlidesStream() {
  slidesHydrator.stop()
  setSlidesBusy(false)
  panelState.slidesRunId = null
}

function setSlidesTranscriptTimedText(value: string | null) {
  slidesTranscriptTimedText = value ?? null
  slidesTranscriptSegments = parseTranscriptTimedText(slidesTranscriptTimedText)
  slidesTranscriptAvailable = slidesTranscriptSegments.length > 0
}

async function fetchSlideTools(): Promise<{
  ok: boolean
  missing: string[]
}> {
  const token = (await loadSettings()).token.trim()
  if (!token) {
    return { ok: false, missing: ['daemon token'] }
  }
  const res = await fetch('http://127.0.0.1:8787/v1/tools', {
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!res.ok) {
    return { ok: false, missing: ['daemon tools endpoint'] }
  }
  const json = (await res.json()) as {
    ok?: boolean
    tools?: {
      ytDlp?: { available?: boolean }
      ffmpeg?: { available?: boolean }
      tesseract?: { available?: boolean }
    }
  }
  if (!json.ok || !json.tools) {
    return { ok: false, missing: ['daemon tools endpoint'] }
  }
  const missing: string[] = []
  if (!json.tools.ytDlp?.available) missing.push('yt-dlp')
  if (!json.tools.ffmpeg?.available) missing.push('ffmpeg')
  if (!json.tools.tesseract?.available) missing.push('tesseract')
  return { ok: missing.length === 0, missing }
}

function showAutomationNotice({
  title,
  message,
  ctaLabel,
  ctaAction,
}: {
  title: string
  message: string
  ctaLabel?: string
  ctaAction?: AutomationNoticeAction
}) {
  automationNoticeTitleEl.textContent = title
  automationNoticeMessageEl.textContent = message
  automationNoticeActionBtn.textContent = ctaLabel || 'Open extension details'
  automationNoticeActionBtn.onclick = () => {
    if (ctaAction === 'options') {
      void chrome.runtime.openOptionsPage()
      return
    }
    void chrome.tabs.create({ url: `chrome://extensions/?id=${chrome.runtime.id}` })
  }
  automationNoticeEl.classList.remove('hidden')
}

window.addEventListener('summarize:automation-permissions', (event) => {
  const detail = (
    event as CustomEvent<{
      title?: string
      message?: string
      ctaLabel?: string
      ctaAction?: AutomationNoticeAction
    }>
  ).detail
  if (!detail?.message) return
  showAutomationNotice({
    title: detail.title ?? 'Automation permission required',
    message: detail.message,
    ctaLabel: detail.ctaLabel,
    ctaAction: detail.ctaAction,
  })
})

type AgentResponse = { ok: boolean; assistant?: AssistantMessage; error?: string }
const pendingAgentRequests = new Map<
  string,
  {
    resolve: (response: AgentResponse) => void
    reject: (error: Error) => void
    onChunk?: (text: string) => void
  }
>()

type ChatHistoryResponse = { ok: boolean; messages?: Message[]; error?: string }
const pendingChatHistoryRequests = new Map<
  string,
  { resolve: (response: ChatHistoryResponse) => void; reject: (error: Error) => void }
>()

function abortPendingAgentRequests(reason: string) {
  for (const pending of pendingAgentRequests.values()) {
    pending.reject(new Error(reason))
  }
  pendingAgentRequests.clear()
}

async function hideReplOverlayForActiveTab() {
  if (!activeTabId) return
  try {
    await chrome.tabs.sendMessage(activeTabId, {
      type: 'automation:repl-overlay',
      action: 'hide',
      message: null,
    })
  } catch {
    // ignore
  }
}

function requestAgentAbort(reason: string) {
  abortAgentRequested = true
  abortPendingAgentRequests(reason)
  headerController.setStatus(reason)
  void hideReplOverlayForActiveTab()
}

function wrapMessage(message: Message): ChatMessage {
  return { ...message, id: crypto.randomUUID() }
}

function buildStreamingAssistantMessage(): ChatMessage {
  return {
    id: crypto.randomUUID(),
    role: 'assistant',
    content: [],
    api: 'openai-completions',
    provider: 'openai',
    model: 'streaming',
    usage: buildEmptyUsage(),
    stopReason: 'stop',
    timestamp: Date.now(),
  }
}

function handleAgentResponse(msg: Extract<BgToPanel, { type: 'agent:response' }>) {
  const pending = pendingAgentRequests.get(msg.requestId)
  if (!pending) return
  pendingAgentRequests.delete(msg.requestId)
  pending.resolve({ ok: msg.ok, assistant: msg.assistant, error: msg.error })
}

function handleAgentChunk(msg: Extract<BgToPanel, { type: 'agent:chunk' }>) {
  const pending = pendingAgentRequests.get(msg.requestId)
  if (!pending?.onChunk) return
  pending.onChunk(msg.text)
}

function handleChatHistoryResponse(msg: Extract<BgToPanel, { type: 'chat:history' }>) {
  const pending = pendingChatHistoryRequests.get(msg.requestId)
  if (!pending) return
  pendingChatHistoryRequests.delete(msg.requestId)
  pending.resolve({ ok: msg.ok, messages: msg.messages, error: msg.error })
}

async function requestAgent(
  messages: Message[],
  tools: string[],
  summary?: string | null,
  opts?: { onChunk?: (text: string) => void }
) {
  const requestId = crypto.randomUUID()
  const response = new Promise<AgentResponse>((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      pendingAgentRequests.delete(requestId)
      reject(new Error('Agent request timed out'))
    }, 60_000)
    pendingAgentRequests.set(requestId, {
      resolve: (result) => {
        window.clearTimeout(timeout)
        resolve(result)
      },
      reject: (error) => {
        window.clearTimeout(timeout)
        reject(error)
      },
      onChunk: opts?.onChunk,
    })
    void send({ type: 'panel:agent', requestId, messages, tools, summary })
  })
  return response
}

async function requestChatHistory(summary?: string | null) {
  const requestId = crypto.randomUUID()
  const response = new Promise<ChatHistoryResponse>((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      pendingChatHistoryRequests.delete(requestId)
      reject(new Error('Chat history request timed out'))
    }, 20_000)
    pendingChatHistoryRequests.set(requestId, {
      resolve: (result) => {
        window.clearTimeout(timeout)
        resolve(result)
      },
      reject: (error) => {
        window.clearTimeout(timeout)
        reject(error)
      },
    })
    void send({ type: 'panel:chat-history', requestId, summary })
  })
  return response
}

chatMessagesEl.addEventListener('click', (event) => {
  const target = event.target as HTMLElement | null
  if (!target) return
  const link = target.closest('a.chatTimestamp') as HTMLAnchorElement | null
  if (!link) return
  const href = link.getAttribute('href') ?? ''
  if (!href.startsWith('timestamp:')) return
  const seconds = parseTimestampHref(href)
  if (seconds == null) return
  event.preventDefault()
  event.stopPropagation()
  void send({ type: 'panel:seek', seconds })
})

renderEl.addEventListener('click', (event) => {
  const target = event.target as HTMLElement | null
  if (!target) return
  const link = target.closest('a.chatTimestamp') as HTMLAnchorElement | null
  if (!link) return
  const href = link.getAttribute('href') ?? ''
  if (!href.startsWith('timestamp:')) return
  const seconds = parseTimestampHref(href)
  if (seconds == null) return
  event.preventDefault()
  event.stopPropagation()
  void send({ type: 'panel:seek', seconds })
})

async function handleSummarizeControlChange(value: { mode: 'page' | 'video'; slides: boolean }) {
  const prevSlides = slidesEnabledValue
  const prevMode = inputMode
  if (value.slides && !slidesEnabledValue) {
    const tools = await fetchSlideTools()
    if (!tools.ok) {
      const missing = tools.missing.join(', ')
      showSlideNotice(`Slide extraction requires ${missing}. Install and restart the daemon.`)
      refreshSummarizeControl()
      return
    }
    hideSlideNotice()
  } else if (!value.slides) {
    hideSlideNotice()
    setSlidesBusy(false)
    stopSlidesStream()
  }
  inputMode = value.mode
  inputModeOverride = value.mode
  slidesEnabledValue = value.slides
  await patchSettings({ slidesEnabled: slidesEnabledValue })
  if (autoValue && (value.mode !== prevMode || value.slides !== prevSlides)) {
    sendSummarize({ refresh: true })
  }
  refreshSummarizeControl()
}

function handleSlidesTextModeChange(next: SlideTextMode) {
  if (next === slidesTextMode) return
  if (next === 'ocr' && !slidesOcrAvailable) return
  slidesTextMode = next
  rebuildSlideDescriptions()
  if (panelState.summaryMarkdown) {
    renderInlineSlides(renderMarkdownHostEl, { fallback: true })
  } else {
    queueSlidesRender()
  }
  refreshSummarizeControl()
}

function applySlidesLayout() {
  const isGallery = slidesLayoutValue === 'gallery'
  renderMarkdownHostEl.classList.remove('hidden')
  renderSlidesHostEl.dataset.layout = slidesLayoutValue
  if (isGallery) {
    clearSlideStrip(renderSlidesHostEl)
  } else {
    clearSlideGallery(renderSlidesHostEl)
  }
  renderMarkdownDisplay()
  queueSlidesRender()
}

function setSlidesLayout(next: SlidesLayout) {
  if (next === slidesLayoutValue) return
  slidesLayoutValue = next
  slidesLayoutEl.value = next
  applySlidesLayout()
}

const summarizeControl = mountSummarizeControl(summarizeControlRoot, {
  mode: inputMode,
  slidesEnabled: slidesEnabledValue,
  mediaAvailable: false,
  videoLabel: 'Video',
  busy: false,
  slidesTextMode,
  slidesTextToggleVisible,
  onSlidesTextModeChange: handleSlidesTextModeChange,
  onChange: handleSummarizeControlChange,
  onSummarize: () => sendSummarize(),
})

function refreshSummarizeControl() {
  summarizeControl.update({
    mode: inputMode,
    slidesEnabled: slidesEnabledValue,
    mediaAvailable,
    busy: slidesBusy,
    videoLabel: summarizeVideoLabel,
    pageWords: summarizePageWords,
    videoDurationSeconds: summarizeVideoDurationSeconds,
    slidesTextMode,
    slidesTextToggleVisible,
    onSlidesTextModeChange: handleSlidesTextModeChange,
    onChange: handleSummarizeControlChange,
    onSummarize: () => sendSummarize(),
  })
}

function normalizeQueueText(input: string) {
  return input.replace(/\s+/g, ' ').trim()
}

function renderChatQueue() {
  if (chatQueue.length === 0) {
    chatQueueEl.classList.add('isHidden')
    chatQueueEl.replaceChildren()
    return
  }
  chatQueueEl.classList.remove('isHidden')
  chatQueueEl.replaceChildren()

  for (const item of chatQueue) {
    const row = document.createElement('div')
    row.className = 'chatQueueItem'
    row.dataset.id = item.id

    const text = document.createElement('div')
    text.className = 'chatQueueText'
    text.textContent = item.text
    text.title = item.text

    const remove = document.createElement('button')
    remove.type = 'button'
    remove.className = 'chatQueueRemove'
    remove.textContent = 'x'
    remove.setAttribute('aria-label', 'Remove queued message')
    remove.addEventListener('click', () => removeQueuedMessage(item.id))

    row.append(text, remove)
    chatQueueEl.append(row)
  }
}

function enqueueChatMessage(input: string): boolean {
  const text = normalizeQueueText(input)
  if (!text) return false
  if (chatQueue.length >= MAX_CHAT_QUEUE) {
    headerController.setStatus(`Queue full (${MAX_CHAT_QUEUE}). Remove one to add more.`)
    return false
  }
  chatQueue.push({ id: crypto.randomUUID(), text, createdAt: Date.now() })
  renderChatQueue()
  return true
}

function removeQueuedMessage(id: string) {
  chatQueue = chatQueue.filter((item) => item.id !== id)
  renderChatQueue()
}

function clearQueuedMessages() {
  if (chatQueue.length === 0) return
  chatQueue = []
  renderChatQueue()
}

const isStreaming = () => panelState.phase === 'connecting' || panelState.phase === 'streaming'

const optionsTabStorageKey = 'summarize:options-tab'

const openOptionsTab = (tabId: string) => {
  try {
    localStorage.setItem(optionsTabStorageKey, tabId)
  } catch {
    // ignore
  }
  void send({ type: 'panel:openOptions' })
}

const headerController = createHeaderController({
  headerEl,
  titleEl,
  subtitleEl,
  progressFillEl,
  getState: () => ({
    phase: panelState.phase,
    summaryFromCache: panelState.summaryFromCache,
  }),
})

headerController.updateHeaderOffset()
window.addEventListener('resize', headerController.updateHeaderOffset)

const errorController = createErrorController({
  panelEl: errorEl,
  panelMessageEl: errorMessageEl,
  panelRetryBtn: errorRetryBtn,
  panelLogsBtn: errorLogsBtn,
  inlineEl: inlineErrorEl,
  inlineMessageEl: inlineErrorMessageEl,
  inlineRetryBtn: inlineErrorRetryBtn,
  inlineLogsBtn: inlineErrorLogsBtn,
  inlineCloseBtn: inlineErrorCloseBtn,
  onRetry: () => retryLastAction(),
  onOpenLogs: () => openOptionsTab('logs'),
  onPanelVisibilityChange: () => headerController.updateHeaderOffset(),
})

const setPhase = (phase: PanelPhase, opts?: { error?: string | null }) => {
  panelState.phase = phase
  panelState.error = phase === 'error' ? (opts?.error ?? panelState.error) : null
  if (phase === 'error') {
    const message =
      panelState.error && panelState.error.trim().length > 0
        ? panelState.error
        : 'Something went wrong.'
    errorController.showPanelError(message)
    setSlidesBusy(false)
  } else {
    errorController.clearPanelError()
    if (phase !== 'streaming' && phase !== 'connecting') {
      setSlidesBusy(false)
    }
  }
  if (phase !== 'connecting' && phase !== 'streaming') {
    headerController.stopProgress()
  }
}

chrome.runtime.onMessage.addListener((raw, _sender, sendResponse) => {
  if (!raw || typeof raw !== 'object') return
  const type = (raw as { type?: string }).type
  if (type === 'automation:abort-agent') {
    requestAgentAbort('Agent aborted')
    sendResponse?.({ ok: true })
    return true
  }
})

let autoScrollLocked = true

const isNearBottom = () => {
  const distance = mainEl.scrollHeight - mainEl.scrollTop - mainEl.clientHeight
  return distance < 32
}

const updateAutoScrollLock = () => {
  autoScrollLocked = isNearBottom()
  chatJumpBtn.classList.toggle('isVisible', !autoScrollLocked)
}

const scrollToBottom = (force = false) => {
  if (force) autoScrollLocked = true
  if (!force && !autoScrollLocked) return
  mainEl.scrollTop = mainEl.scrollHeight
  chatJumpBtn.classList.remove('isVisible')
}

mainEl.addEventListener('scroll', updateAutoScrollLock, { passive: true })
updateAutoScrollLock()

chatJumpBtn.addEventListener('click', () => {
  scrollToBottom(true)
  chatInputEl.focus()
})

const updateChatDockHeight = () => {
  const height = chatDockEl.getBoundingClientRect().height
  document.documentElement.style.setProperty('--chat-dock-height', `${height}px`)
}

updateChatDockHeight()
const chatDockObserver = new ResizeObserver(() => updateChatDockHeight())
chatDockObserver.observe(chatDockEl)

function normalizeUrl(value: string) {
  try {
    const url = new URL(value)
    url.hash = ''
    return url.toString()
  } catch {
    return value
  }
}

function urlsMatch(a: string, b: string) {
  const left = normalizeUrl(a)
  const right = normalizeUrl(b)
  if (left === right) return true
  const boundaryMatch = (longer: string, shorter: string) => {
    if (!longer.startsWith(shorter)) return false
    if (longer.length === shorter.length) return true
    const next = longer[shorter.length]
    return next === '/' || next === '?' || next === '&'
  }
  return boundaryMatch(left, right) || boundaryMatch(right, left)
}

function markAgentNavigationIntent(url: string | null | undefined) {
  const trimmed = typeof url === 'string' ? url.trim() : ''
  if (!trimmed) return
  lastAgentNavigation = { url: trimmed, tabId: null, at: Date.now() }
}

function markAgentNavigationResult(details: unknown) {
  if (!details || typeof details !== 'object') return
  const obj = details as { finalUrl?: unknown; tabId?: unknown }
  const finalUrl = typeof obj.finalUrl === 'string' ? obj.finalUrl.trim() : ''
  const tabId = typeof obj.tabId === 'number' ? obj.tabId : null
  if (!finalUrl && tabId == null) return
  lastAgentNavigation = {
    url: finalUrl || lastAgentNavigation?.url || '',
    tabId,
    at: Date.now(),
  }
}

function isRecentAgentNavigation(tabId: number | null, url: string | null) {
  if (!lastAgentNavigation) return false
  if (Date.now() - lastAgentNavigation.at > AGENT_NAV_TTL_MS) {
    lastAgentNavigation = null
    return false
  }
  if (tabId != null && lastAgentNavigation.tabId != null && tabId === lastAgentNavigation.tabId) {
    return true
  }
  if (url && lastAgentNavigation.url && urlsMatch(url, lastAgentNavigation.url)) {
    return true
  }
  return false
}

function notePreserveChatForUrl(url: string | null) {
  if (!url) return
  pendingPreserveChatForUrl = { url, at: Date.now() }
}

function shouldPreserveChatForRun(url: string) {
  const pending = pendingPreserveChatForUrl
  if (pending && Date.now() - pending.at < AGENT_NAV_TTL_MS && urlsMatch(url, pending.url)) {
    pendingPreserveChatForUrl = null
    return true
  }
  return isRecentAgentNavigation(null, url)
}

async function migrateChatHistory(fromTabId: number | null, toTabId: number | null) {
  if (!fromTabId || !toTabId || fromTabId === toTabId) return
  const messages = chatController.getMessages()
  if (messages.length === 0) return
  chatHistoryCache.set(toTabId, messages)
  const store = chrome.storage?.session
  if (!store) return
  try {
    await store.set({ [getChatHistoryKey(toTabId)]: messages })
  } catch {
    // ignore
  }
}

async function appendNavigationMessage(url: string, title: string | null) {
  if (!url || lastNavigationMessageUrl === url) return
  lastNavigationMessageUrl = url

  const skills = await listSkills(url)
  const skillsText =
    skills.length === 0
      ? 'Skills: none'
      : `Skills:\n${skills.map((skill) => `- ${skill.name}: ${skill.shortDescription}`).join('\n')}`

  const text = ['Navigation changed', `Title: ${title || url}`, `URL: ${url}`, skillsText].join(
    '\n'
  )

  const message: ToolResultMessage = {
    role: 'toolResult',
    toolCallId: crypto.randomUUID(),
    toolName: 'navigation',
    content: [{ type: 'text', text }],
    isError: false,
    timestamp: Date.now(),
  }

  chatController.addMessage(wrapMessage(message))
  scrollToBottom(true)
  void persistChatHistory()
}

function canSyncTabUrl(url: string | null | undefined): url is string {
  if (!url) return false
  if (url.startsWith('chrome://')) return false
  if (url.startsWith('chrome-extension://')) return false
  if (url.startsWith('moz-extension://')) return false // Firefox extension pages
  if (url.startsWith('edge://')) return false
  if (url.startsWith('about:')) return false
  return true
}

async function syncWithActiveTab() {
  if (!panelState.currentSource) return
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
    if (!tab?.url || !canSyncTabUrl(tab.url)) return
    if (!urlsMatch(tab.url, panelState.currentSource.url)) {
      const preserveChat = isRecentAgentNavigation(tab.id ?? null, tab.url)
      if (preserveChat) {
        notePreserveChatForUrl(tab.url)
      }
      panelState.currentSource = null
      currentRunTabId = null
      setPhase('idle')
      resetSummaryView({ preserveChat })
      headerController.setBaseTitle(tab.title || tab.url || 'Summarize')
      headerController.setBaseSubtitle('')
      return
    }
    if (tab.title && tab.title !== panelState.currentSource.title) {
      panelState.currentSource = { ...panelState.currentSource, title: tab.title }
      headerController.setBaseTitle(tab.title)
    }
  } catch {
    // ignore
  }
}

function resetSummaryView({
  preserveChat = false,
  clearRunId = true,
}: {
  preserveChat?: boolean
  clearRunId?: boolean
} = {}) {
  currentRunTabId = null
  renderEl.replaceChildren(renderSlidesHostEl, renderMarkdownHostEl)
  renderMarkdownHostEl.innerHTML = ''
  clearSlideStrip(renderSlidesHostEl)
  clearSlideGallery(renderSlidesHostEl)
  clearMetricsForMode('summary')
  panelState.summaryMarkdown = null
  panelState.summaryFromCache = null
  panelState.slides = null
  if (clearRunId) {
    panelState.runId = null
    panelState.slidesRunId = null
  }
  slidesExpanded = true
  slidesContextPending = false
  slidesContextUrl = null
  setSlidesTranscriptTimedText(null)
  slidesOcrAvailable = false
  slidesTextToggleVisible = false
  slidesTextMode = 'transcript'
  slideDescriptions = new Map()
  slideSummaryByIndex = new Map()
  slideTitleByIndex = new Map()
  stopSlidesStream()
  refreshSummarizeControl()
  if (!preserveChat) {
    resetChatState()
  }
}

async function clearCurrentView() {
  if (panelState.chatStreaming) {
    requestAgentAbort('Cleared')
  }
  streamController.abort()
  stopSlidesStream()
  resetSummaryView({ preserveChat: false })
  await clearChatHistoryForActiveTab()
  panelCacheController.scheduleSync()
  headerController.setStatus('')
  setPhase('idle')
}

function buildPanelCachePayload(): PanelCachePayload | null {
  const tabId = currentRunTabId ?? activeTabId
  const url = panelState.currentSource?.url ?? activeTabUrl
  if (!tabId || !url) return null
  return {
    tabId,
    url,
    title: panelState.currentSource?.title ?? null,
    runId: panelState.runId ?? null,
    slidesRunId: panelState.slidesRunId ?? null,
    summaryMarkdown: panelState.summaryMarkdown ?? null,
    summaryFromCache: panelState.summaryFromCache ?? null,
    lastMeta: panelState.lastMeta,
    slides: panelState.slides ?? null,
    transcriptTimedText: slidesTranscriptTimedText ?? null,
  }
}

function applyPanelCache(payload: PanelCachePayload, opts?: { preserveChat?: boolean }) {
  const preserveChat = opts?.preserveChat ?? false
  resetSummaryView({ preserveChat })
  panelState.runId = payload.runId ?? null
  panelState.slidesRunId = payload.slidesRunId ?? payload.runId ?? null
  currentRunTabId = payload.tabId
  panelState.currentSource = { url: payload.url, title: payload.title ?? null }
  panelState.lastMeta = payload.lastMeta ?? { inputSummary: null, model: null, modelLabel: null }
  panelState.summaryFromCache = payload.summaryFromCache ?? null
  headerController.setBaseTitle(payload.title || payload.url || 'Summarize')
  headerController.setBaseSubtitle(
    buildIdleSubtitle({
      inputSummary: panelState.lastMeta.inputSummary,
      modelLabel: panelState.lastMeta.modelLabel,
      model: panelState.lastMeta.model,
    })
  )
  setSlidesTranscriptTimedText(payload.transcriptTimedText ?? null)
  if (payload.slides) {
    panelState.slides = {
      ...payload.slides,
      slides: payload.slides.slides.map((slide) => ({
        ...slide,
        imageUrl: normalizeSlideImageUrl(
          slide.imageUrl,
          payload.slides?.sourceId ?? '',
          slide.index
        ),
      })),
    }
    slidesContextPending = false
    slidesContextUrl = payload.url
    updateSlidesTextState()
    if (!slidesTranscriptAvailable) {
      void requestSlidesContext()
    }
  } else {
    panelState.slides = null
    slidesContextPending = false
    slidesContextUrl = null
    updateSlidesTextState()
  }
  slidesHydrator.syncFromCache({
    runId: panelState.slidesRunId ?? null,
    summaryFromCache: payload.summaryFromCache,
    hasSlides: Boolean(payload.slides && payload.slides.slides.length > 0),
  })
  if (payload.summaryMarkdown) {
    renderMarkdown(payload.summaryMarkdown)
  } else {
    renderMarkdownDisplay()
  }
  queueSlidesRender()
  setPhase('idle')
}

const panelCacheController = createPanelCacheController({
  getSnapshot: buildPanelCachePayload,
  sendCache: (payload) => {
    void send({ type: 'panel:cache', cache: payload })
  },
  sendRequest: (request) => {
    void send({ type: 'panel:get-cache', ...request })
  },
})

window.addEventListener('error', (event) => {
  const message =
    event.error instanceof Error ? event.error.stack || event.error.message : event.message
  headerController.setStatus(`Error: ${message}`)
  setPhase('error', { error: message })
})

window.addEventListener('unhandledrejection', (event) => {
  const reason = (event as PromiseRejectionEvent).reason
  const message = reason instanceof Error ? reason.stack || reason.message : String(reason)
  headerController.setStatus(`Error: ${message}`)
  setPhase('error', { error: message })
})

const SLIDE_LABEL_PATTERN =
  /^(?:\[)?slide\s+(\d+)(?:\s*(?:\/|of)\s*\d+)?(?:\])?(?:\s*[\u00b7:-]\s*.*)?$/i
const SLIDE_TAG_PATTERN = /^\[slide:(\d+)\]\s*(.*)$/i

function findSlidesSectionStart(markdown: string): number | null {
  if (!markdown) return null
  const heading = markdown.match(/^#{1,3}\s+Slides\b.*$/im)
  const tag = markdown.match(/^\[slide:\d+\]/im)
  const label = markdown.match(/^\s*slide\s+\d+(?:\s*(?:\/|of)\s*\d+)?(?:\s*[\u00b7:-].*)?$/im)
  const indexes = [heading?.index, tag?.index, label?.index].filter(
    (idx): idx is number => idx != null
  )
  if (indexes.length === 0) return null
  return Math.min(...indexes)
}

function deriveHeadlineFromBody(body: string): string | null {
  const cleaned = body.trim().replace(/\s+/g, ' ')
  if (!cleaned) return null
  const firstSentence = cleaned.split(/[.!?]/)[0] ?? ''
  const clause = firstSentence.split(/[,;:\u2013\u2014-]/)[0] ?? firstSentence
  const words = clause.trim().split(/\s+/).filter(Boolean)
  if (words.length < 2) return null
  const title = words.slice(0, Math.min(6, words.length)).join(' ')
  return title.replace(/[,:;-]+$/g, '').trim() || null
}

function splitSlidesMarkdown(markdown: string): { summary: string; slides: string | null } {
  const startAt = findSlidesSectionStart(markdown)
  if (startAt == null) return { summary: markdown.trim(), slides: null }
  const summary = markdown.slice(0, startAt).trim()
  const slides = markdown.slice(startAt).trim()
  return { summary, slides: slides.length > 0 ? slides : null }
}

function selectMarkdownForLayout(markdown: string): string {
  const trimmed = markdown.trim()
  if (!trimmed) return ''
  const { summary, slides } = splitSlidesMarkdown(markdown)
  if (slidesLayoutValue === 'strip') return summary || slides || markdown
  if (slidesLayoutValue === 'gallery') return summary || slides || markdown
  return markdown
}

function renderMarkdownDisplay() {
  const markdown = panelState.summaryMarkdown ?? ''
  const displayMarkdown = selectMarkdownForLayout(markdown)
  try {
    renderMarkdownHostEl.innerHTML = md.render(linkifyTimestamps(displayMarkdown))
  } catch (err) {
    const message = err instanceof Error ? err.stack || err.message : String(err)
    headerController.setStatus(`Error: ${message}`)
    return
  }
  for (const a of Array.from(renderMarkdownHostEl.querySelectorAll('a'))) {
    const href = a.getAttribute('href') ?? ''
    if (href.startsWith('timestamp:')) {
      a.classList.add('chatTimestamp')
      a.removeAttribute('target')
      a.removeAttribute('rel')
      continue
    }
    a.setAttribute('target', '_blank')
    a.setAttribute('rel', 'noopener noreferrer')
  }
  renderInlineSlides(renderMarkdownHostEl, { fallback: true })
}

function renderMarkdown(markdown: string) {
  panelState.summaryMarkdown = markdown
  updateSlideSummaryFromMarkdown(markdown)
  renderMarkdownDisplay()
  panelCacheController.scheduleSync()
}

function updateSlideSummaryFromMarkdown(markdown: string) {
  const parsed = parseSlideSummariesFromMarkdown(markdown)
  slideSummaryByIndex = parsed.summaries
  slideTitleByIndex = parsed.titles
  rebuildSlideDescriptions()
  queueSlidesRender()
}

function parseSlideSummariesFromMarkdown(markdown: string): {
  summaries: Map<number, string>
  titles: Map<number, string>
} {
  const summaries = new Map<number, string>()
  const titles = new Map<number, string>()
  if (!markdown.trim()) return { summaries, titles }
  const startAt = findSlidesSectionStart(markdown)
  if (startAt == null) return { summaries, titles }
  const slice = markdown.slice(startAt)
  const isTitleCandidate = (line: string) => line.length <= 80 && !/[.!?]/.test(line)

  const lines = slice.split('\n')
  let currentIndex: number | null = null
  let buffer: string[] = []
  let sawBlankAfterTitle = false
  const hasFutureMarker = (start: number) =>
    lines.slice(start).some((line) => {
      const trimmed = line.trim()
      return SLIDE_TAG_PATTERN.test(trimmed) || SLIDE_LABEL_PATTERN.test(trimmed)
    })
  const flush = () => {
    if (currentIndex == null) return
    const raw = buffer.join('\n').trim()
    if (raw) {
      const lines = raw
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .filter((line) => !SLIDE_LABEL_PATTERN.test(line) && !/^\[slide:\d+\]/i.test(line))
      if (lines.length === 0) {
        currentIndex = null
        buffer = []
        return
      }
      let title: string | null = null
      let titleIndex: number | null = null
      const titleLineIndex = lines.findIndex((line) => /^(?:title|headline)\s*:\s*/i.test(line))
      if (titleLineIndex >= 0) {
        const labelMatch = lines[titleLineIndex]?.match(/^(?:title|headline)\s*:\s*(.*)$/i)
        title = (labelMatch?.[1] ?? '').trim() || null
        titleIndex = titleLineIndex
      }
      if (!title) {
        const headingIndex = lines.findIndex((line) => /^#{1,6}\s+/.test(line))
        if (headingIndex >= 0) {
          const headingMatch = lines[headingIndex]?.match(/^#{1,6}\s+(.+)/)
          const headingText = (headingMatch?.[1] ?? '').trim()
          const headingLabelMatch = headingText.match(/^(?:title|headline)\s*:\s*(.*)$/i)
          if (headingLabelMatch) {
            const headingLabel = (headingLabelMatch[1] ?? '').trim()
            if (headingLabel) {
              title = headingLabel
            } else {
              const fallbackTitle = (lines[headingIndex + 1] ?? '').trim()
              if (fallbackTitle) title = fallbackTitle
            }
          } else {
            title = headingText || null
          }
          titleIndex = headingIndex
        }
      }
      if (!title && lines.length > 1) {
        const candidates = lines
          .map((line, idx) => ({ line, idx }))
          .filter(({ line }) => isTitleCandidate(line))
        if (candidates.length === 1) {
          title = candidates[0]?.line ?? null
          titleIndex = candidates[0]?.idx ?? null
        } else if (isTitleCandidate(lines[0] ?? '')) {
          title = lines[0] ?? null
          titleIndex = 0
        }
      }
      const bodyLines = lines.filter((line, idx) => {
        if (titleIndex != null && idx === titleIndex) return false
        if (/^(?:title|headline)\s*:/i.test(line)) return false
        if (/^#{1,6}\s+/.test(line)) return false
        return true
      })
      const body = bodyLines.join(' ').trim().replace(/\s+/g, ' ')
      if (!title && body) {
        title = deriveHeadlineFromBody(body)
      }
      if (body) summaries.set(currentIndex, body)
      if (title) titles.set(currentIndex, title)
    }
    currentIndex = null
    buffer = []
    sawBlankAfterTitle = false
  }

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? ''
    const trimmed = line.trim()
    const heading = trimmed.match(/^#{1,3}\s+\S/)
    if (heading && !trimmed.toLowerCase().startsWith('### slides')) {
      flush()
      break
    }
    const match = trimmed.match(SLIDE_TAG_PATTERN)
    if (match) {
      flush()
      const index = Number.parseInt(match[1] ?? '', 10)
      if (!Number.isFinite(index) || index <= 0) continue
      currentIndex = index
      sawBlankAfterTitle = false
      const rest = (match[2] ?? '').trim()
      if (rest) buffer.push(rest)
      continue
    }
    const labelMatch = trimmed.match(SLIDE_LABEL_PATTERN)
    if (labelMatch) {
      flush()
      const index = Number.parseInt(labelMatch[1] ?? '', 10)
      if (!Number.isFinite(index) || index <= 0) continue
      currentIndex = index
      sawBlankAfterTitle = false
      continue
    }
    if (currentIndex == null) continue
    if (!trimmed) {
      if (buffer.length === 1 && isTitleCandidate(buffer[0] ?? '')) {
        sawBlankAfterTitle = true
      }
      continue
    }
    if (
      sawBlankAfterTitle &&
      buffer.length === 1 &&
      isTitleCandidate(buffer[0] ?? '') &&
      !isTitleCandidate(trimmed) &&
      !hasFutureMarker(i)
    ) {
      flush()
      break
    }
    sawBlankAfterTitle = false
    buffer.push(trimmed)
  }
  flush()
  return { summaries, titles }
}

function setSlidesBusy(next: boolean) {
  if (slidesBusy === next) return
  slidesBusy = next
  const toggle = document.querySelector<HTMLButtonElement>('.summarizeSlideToggle')
  if (toggle) {
    toggle.dataset.busy = next ? 'true' : 'false'
  }
  headerController.setProgressOverride(next)
  refreshSummarizeControl()
}

function formatSlideTimestamp(seconds: number | null | undefined): string | null {
  if (seconds == null || !Number.isFinite(seconds)) return null
  const total = Math.max(0, Math.floor(seconds))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const secs = total % 60
  const mm = minutes.toString().padStart(2, '0')
  const ss = secs.toString().padStart(2, '0')
  return hours > 0 ? `${hours}:${mm}:${ss}` : `${minutes}:${ss}`
}

function seekToSlideTimestamp(seconds: number | null | undefined) {
  if (seconds == null || !Number.isFinite(seconds)) return
  void send({ type: 'panel:seek', seconds: Math.floor(seconds) })
}

const SLIDE_TEXT_MIN_CHARS = 120
const SLIDE_TEXT_MAX_CHARS = 600
const SLIDE_TEXT_WINDOW_MIN_SECONDS = 30
const SLIDE_TEXT_WINDOW_MAX_SECONDS = 180
const SLIDE_OCR_MIN_CHARS = 16
const SLIDE_OCR_SIGNIFICANT_TOTAL = 200
const SLIDE_OCR_SIGNIFICANT_SLIDES = 3
const SLIDE_OCR_GIBBERISH_MIN_CHARS = 24
const SLIDE_OCR_GIBBERISH_MIN_TOKENS = 8
const SLIDE_OCR_GIBBERISH_MAX_SHORT_TOKEN_RATIO = 0.55
const SLIDE_OCR_GIBBERISH_MAX_SYMBOL_RATIO = 0.42
const SLIDE_OCR_GIBBERISH_WEIRD_SYMBOL_RATIO = 0.08
const SLIDE_CUSTOM_LENGTH_PATTERN = /^(?<value>\d+(?:\.\d+)?)(?<unit>k|m)?$/i

function resolveLengthTargetCharacters(lengthValue: string): number | null {
  const normalized = lengthValue.trim().toLowerCase()
  if (Object.hasOwn(SUMMARY_LENGTH_SPECS, normalized)) {
    const spec = SUMMARY_LENGTH_SPECS[normalized as keyof typeof SUMMARY_LENGTH_SPECS]
    return spec?.targetCharacters ?? null
  }
  const match = normalized.match(SLIDE_CUSTOM_LENGTH_PATTERN)
  if (!match) return null
  const value = Number(match.groups?.value ?? match[1])
  if (!Number.isFinite(value) || value <= 0) return null
  const unit = (match.groups?.unit ?? '').toLowerCase()
  const multiplier = unit === 'm' ? 1_000_000 : unit === 'k' ? 1_000 : 1
  return Math.round(value * multiplier)
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function resolveSlideTextBudget(lengthValue: string): number {
  const target =
    resolveLengthTargetCharacters(lengthValue) ?? SUMMARY_LENGTH_SPECS.short.targetCharacters
  const perSlide = Math.round(target / 15)
  return clampNumber(perSlide, SLIDE_TEXT_MIN_CHARS, SLIDE_TEXT_MAX_CHARS)
}

function resolveSlideWindowSeconds(lengthValue: string): number {
  const target =
    resolveLengthTargetCharacters(lengthValue) ?? SUMMARY_LENGTH_SPECS.short.targetCharacters
  const window = Math.round(target / 100)
  return clampNumber(window, SLIDE_TEXT_WINDOW_MIN_SECONDS, SLIDE_TEXT_WINDOW_MAX_SECONDS)
}

function normalizeSlideText(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

function normalizeOcrText(raw: string | null | undefined): string {
  const text = normalizeSlideText(raw ?? '')
  if (!text) return ''
  if (text.length < SLIDE_OCR_GIBBERISH_MIN_CHARS) return text

  const tokens = text.split(' ').filter(Boolean)
  if (tokens.length === 0) return ''

  const wordishTokens = tokens
    .map((token) => token.replace(/[^\p{L}]/gu, ''))
    .filter((token) => token.length > 0)
  const letterTokens = wordishTokens
  const shortLetterTokens = letterTokens.filter((token) => token.length <= 3)
  const longWordishTokens = tokens.filter((token) => {
    const stripped = token.replace(/[^\p{L}\p{N}]/gu, '')
    return stripped.length >= 4 && /\p{L}/u.test(stripped)
  })

  const mixedCaseTokens = letterTokens.filter((token) => /[A-Z]/.test(token) && /[a-z]/.test(token))
  const hasLongWord = letterTokens.some((token) => token.length >= 5 && /[aeiou]/i.test(token))

  const chars = Array.from(text)
  const letters = chars.filter((char) => /\p{L}/u.test(char)).length
  const digits = chars.filter((char) => /\p{N}/u.test(char)).length
  const spaces = chars.filter((char) => char === ' ').length
  const symbols = Math.max(0, chars.length - letters - digits - spaces)
  const symbolRatio = chars.length > 0 ? symbols / chars.length : 0
  const weirdSymbols = chars.filter((char) => /[=^~`_|]/.test(char)).length
  const weirdSymbolRatio = chars.length > 0 ? weirdSymbols / chars.length : 0

  if (
    tokens.length >= SLIDE_OCR_GIBBERISH_MIN_TOKENS &&
    letterTokens.length > 0 &&
    shortLetterTokens.length / letterTokens.length >= SLIDE_OCR_GIBBERISH_MAX_SHORT_TOKEN_RATIO &&
    longWordishTokens.length < 2
  ) {
    return ''
  }

  if (
    tokens.length >= SLIDE_OCR_GIBBERISH_MIN_TOKENS &&
    letterTokens.length > 0 &&
    !hasLongWord &&
    mixedCaseTokens.length / letterTokens.length >= 0.45 &&
    longWordishTokens.length < 2
  ) {
    return ''
  }

  if (
    symbolRatio >= SLIDE_OCR_GIBBERISH_MAX_SYMBOL_RATIO &&
    weirdSymbolRatio >= SLIDE_OCR_GIBBERISH_WEIRD_SYMBOL_RATIO &&
    longWordishTokens.length < 2
  ) {
    return ''
  }

  return text
}

function truncateSlideText(value: string, limit: number): string {
  if (value.length <= limit) return value
  const truncated = value.slice(0, limit).trimEnd()
  const clean = truncated.replace(/\s+\S*$/, '').trim()
  const result = clean.length > 0 ? clean : truncated.trim()
  return result.length > 0 ? `${result}...` : ''
}

function parseTranscriptTimedText(input: string | null | undefined): TranscriptSegment[] {
  if (!input) return []
  const segments: TranscriptSegment[] = []
  const lines = input.split('\n')
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('[')) continue
    const match = trimmed.match(/^\[(\d{1,2}:\d{2}(?::\d{2})?)\]\s*(.*)$/)
    if (!match) continue
    const seconds = parseTimestampSeconds(match[1])
    if (seconds == null) continue
    const text = normalizeSlideText(match[2] ?? '')
    if (!text) continue
    segments.push({ startSeconds: seconds, text })
  }
  segments.sort((a, b) => a.startSeconds - b.startSeconds)
  return segments
}

function getTranscriptTextForSlide(
  slide: { timestamp?: number | null },
  nextSlide: { timestamp?: number | null } | null,
  budget: number,
  windowSeconds: number
): string {
  if (slide.timestamp == null || !Number.isFinite(slide.timestamp)) return ''
  if (slidesTranscriptSegments.length === 0) return ''
  const start = Math.max(0, Math.floor(slide.timestamp))
  const leadIn = Math.min(6, Math.floor(windowSeconds * 0.2))
  const lower = Math.max(0, start - leadIn)
  let upper = start + windowSeconds
  if (nextSlide?.timestamp != null && Number.isFinite(nextSlide.timestamp)) {
    const next = Math.max(start, Math.floor(nextSlide.timestamp))
    if (next > start) {
      upper = Math.min(upper, next)
    }
  }
  if (upper < lower) return ''
  const parts: string[] = []
  for (const segment of slidesTranscriptSegments) {
    if (segment.startSeconds < lower) continue
    if (segment.startSeconds > upper) break
    parts.push(segment.text)
  }
  const text = normalizeSlideText(parts.join(' '))
  return text ? truncateSlideText(text, budget) : ''
}

function getOcrTextForSlide(slide: { ocrText?: string | null }, budget: number): string {
  const text = normalizeOcrText(slide.ocrText)
  return text ? truncateSlideText(text, budget) : ''
}

function rebuildSlideDescriptions() {
  slideDescriptions = new Map()
  if (!panelState.slides) return
  const budget = resolveSlideTextBudget(pickerSettings.length)
  const windowSeconds = resolveSlideWindowSeconds(pickerSettings.length)
  const hasSummary = slideSummaryByIndex.size > 0
  const effectiveInputMode = inputModeOverride ?? inputMode
  const holdTranscriptFallback =
    !hasSummary &&
    slidesEnabledValue &&
    effectiveInputMode === 'video' &&
    (panelState.phase === 'connecting' || panelState.phase === 'streaming')
  const slides = panelState.slides.slides
  for (let i = 0; i < slides.length; i += 1) {
    const slide = slides[i]
    const nextSlide = slides[i + 1] ?? null
    if (slidesTextMode === 'ocr') {
      slideDescriptions.set(slide.index, getOcrTextForSlide(slide, budget))
      continue
    }
    if (hasSummary) {
      slideDescriptions.set(slide.index, slideSummaryByIndex.get(slide.index) ?? '')
      continue
    }
    if (holdTranscriptFallback) {
      slideDescriptions.set(slide.index, '')
      continue
    }
    const transcriptText = getTranscriptTextForSlide(slide, nextSlide, budget, windowSeconds)
    if (!transcriptText) {
      slideDescriptions.set(slide.index, getOcrTextForSlide(slide, budget))
      continue
    }
    slideDescriptions.set(slide.index, transcriptText)
  }
}

function updateSlidesTextState() {
  slidesOcrAvailable = false
  slidesTextToggleVisible = false
  let ocrTotal = 0
  let ocrSlides = 0
  if (panelState.slides) {
    for (const slide of panelState.slides.slides) {
      const text = normalizeOcrText(slide.ocrText)
      if (text.length > 0) slidesOcrAvailable = true
      if (text.length >= SLIDE_OCR_MIN_CHARS) {
        ocrTotal += text.length
        ocrSlides += 1
      }
    }
  }
  const ocrSignificant =
    slidesOcrAvailable &&
    ocrTotal >= SLIDE_OCR_SIGNIFICANT_TOTAL &&
    ocrSlides >= SLIDE_OCR_SIGNIFICANT_SLIDES
  slidesTextToggleVisible = slidesTranscriptAvailable && ocrSignificant
  if (slidesTranscriptAvailable) {
    if (!slidesTextToggleVisible) {
      slidesTextMode = 'transcript'
    } else if (!slidesOcrAvailable && slidesTextMode === 'ocr') {
      slidesTextMode = 'transcript'
    }
  } else if (slidesOcrAvailable) {
    slidesTextMode = 'ocr'
  } else {
    slidesTextMode = 'transcript'
  }
  rebuildSlideDescriptions()
  refreshSummarizeControl()
  queueSlidesRender()
}

function mergeSlidesPayload(
  prev: NonNullable<PanelState['slides']>,
  next: NonNullable<PanelState['slides']>
): NonNullable<PanelState['slides']> {
  if (prev.sourceId !== next.sourceId) return next
  const mergedByIndex = new Map<number, NonNullable<PanelState['slides']>['slides'][number]>()
  for (const slide of prev.slides) mergedByIndex.set(slide.index, slide)
  for (const slide of next.slides) {
    const existing = mergedByIndex.get(slide.index)
    mergedByIndex.set(slide.index, existing ? { ...existing, ...slide } : slide)
  }
  const mergedSlides = Array.from(mergedByIndex.values()).sort((a, b) => a.index - b.index)
  return {
    ...prev,
    ...next,
    slides: mergedSlides,
  }
}

function slidesPayloadChanged(
  prev: NonNullable<PanelState['slides']> | null,
  next: NonNullable<PanelState['slides']>
): boolean {
  if (!prev) return true
  if (prev.sourceId !== next.sourceId) return true
  if (prev.slides.length !== next.slides.length) return true
  for (let i = 0; i < next.slides.length; i += 1) {
    const current = next.slides[i]
    const prior = prev.slides[i]
    if (!prior || current.index !== prior.index) return true
    if (current.timestamp !== prior.timestamp) return true
    if (current.imageUrl !== prior.imageUrl) return true
    if ((current.ocrText ?? null) !== (prior.ocrText ?? null)) return true
    if ((current.ocrConfidence ?? null) !== (prior.ocrConfidence ?? null)) return true
  }
  if (next.ocrAvailable !== prev.ocrAvailable) return true
  return false
}

function updateSlideThumb(
  img: HTMLImageElement,
  thumb: HTMLElement,
  imageUrl: string | null | undefined
) {
  if (imageUrl) {
    thumb.classList.remove('isPlaceholder')
    slideImageLoader.observe(img, imageUrl)
    return
  }
  thumb.classList.add('isPlaceholder')
  img.removeAttribute('src')
  img.dataset.loaded = 'false'
  img.dataset.slideImageUrl = ''
}

function updateSlideMeta(
  el: HTMLElement,
  index: number,
  timestamp: number | null | undefined,
  title?: string | null,
  total?: number | null
) {
  const formatted = formatSlideTimestamp(timestamp)
  const totalCount = typeof total === 'number' && total > 0 ? total : null
  const slideLabel = totalCount ? `Slide ${index}/${totalCount}` : `Slide ${index}`
  if (title) {
    el.textContent = formatted ? `${title} · ${formatted}` : title
    return
  }
  if (formatted) {
    el.textContent = `${slideLabel} · ${formatted}`
    return
  }
  el.textContent = slideLabel
}

function bindSlideSeek(el: HTMLElement, timestamp: number | null | undefined) {
  el.onclick = () => {
    seekToSlideTimestamp(timestamp)
  }
}

function applySlidesPayload(data: SseSlidesData) {
  const isSameSource = Boolean(panelState.slides && panelState.slides.sourceId === data.sourceId)
  const normalized: SseSlidesData = {
    ...data,
    slides: data.slides.map((slide) => ({
      ...slide,
      imageUrl: normalizeSlideImageUrl(slide.imageUrl, data.sourceId, slide.index),
    })),
  }
  const merged = panelState.slides ? mergeSlidesPayload(panelState.slides, normalized) : normalized
  if (!slidesPayloadChanged(panelState.slides, merged)) return
  panelState.slides = merged
  if (!isSameSource) {
    slidesContextPending = false
    slidesContextUrl = null
    setSlidesTranscriptTimedText(null)
    void requestSlidesContext()
  }
  updateSlidesTextState()
  if (panelState.summaryMarkdown) {
    renderInlineSlides(renderMarkdownHostEl, { fallback: true })
  }
  renderInlineSlides(chatMessagesEl)
  queueSlidesRender()
  panelCacheController.scheduleSync()
}

const slidesTestHooks = (
  globalThis as {
    __summarizeTestHooks?: {
      applySlidesPayload?: (payload: SseSlidesData) => void
      getRunId?: () => string | null
    }
  }
).__summarizeTestHooks
if (slidesTestHooks) {
  slidesTestHooks.applySlidesPayload = applySlidesPayload
  slidesTestHooks.getRunId = () => panelState.runId
}

async function requestSlidesContext() {
  if (!panelState.slides || slidesContextPending) return
  const sourceUrl = panelState.slides.sourceUrl || panelState.currentSource?.url || null
  if (sourceUrl && slidesContextUrl === sourceUrl) return
  slidesContextPending = true
  slidesContextRequestId += 1
  const requestId = `slides-${slidesContextRequestId}`
  slidesContextUrl = sourceUrl
  void send({ type: 'panel:slides-context', requestId })
}

const MAX_SLIDE_STRIP = 12
let slideStripRenderQueued = 0
let slideGalleryRenderQueued = 0

function queueSlidesRender() {
  if (slidesLayoutValue === 'gallery') {
    queueSlideGalleryRender()
  } else {
    queueSlideStripRender()
  }
}

function queueSlideStripRender() {
  if (slidesLayoutValue !== 'strip') {
    clearSlideStrip(renderSlidesHostEl)
    return
  }
  if (slideStripRenderQueued) return
  slideStripRenderQueued = window.setTimeout(() => {
    slideStripRenderQueued = 0
    renderSlideStrip(renderSlidesHostEl)
  }, 120)
}

function queueSlideGalleryRender() {
  if (slidesLayoutValue !== 'gallery') {
    clearSlideGallery(renderSlidesHostEl)
    return
  }
  if (slideGalleryRenderQueued) return
  slideGalleryRenderQueued = window.setTimeout(() => {
    slideGalleryRenderQueued = 0
    renderSlideGallery(renderSlidesHostEl)
  }, 120)
}

function clearSlideStrip(container: HTMLElement) {
  const existing = container.querySelector('.slideStrip')
  if (existing) existing.remove()
}

function clearSlideGallery(container: HTMLElement) {
  const existing = container.querySelector('.slideGallery')
  if (existing) existing.remove()
}

function renderSlideStrip(container: HTMLElement) {
  if (slidesLayoutValue !== 'strip') {
    clearSlideStrip(container)
    return
  }
  if (!panelState.slides) return
  const allSlides = panelState.slides.slides
  const slides = slidesExpanded ? allSlides : allSlides.slice(0, MAX_SLIDE_STRIP)
  if (allSlides.length === 0 || slides.length === 0) {
    clearSlideStrip(container)
    return
  }

  const existing = container.querySelector<HTMLDivElement>('.slideStrip')
  const sourceId = panelState.slides.sourceId
  const expectedMode = slidesExpanded ? 'expanded' : 'collapsed'
  if (
    !existing ||
    existing.dataset.sourceId !== sourceId ||
    existing.dataset.mode !== expectedMode
  ) {
    clearSlideStrip(container)
    const root = document.createElement('div')
    root.className = 'slideStrip'
    root.dataset.sourceId = sourceId
    root.dataset.mode = expectedMode

    const header = document.createElement('div')
    header.className = 'slideStrip__header'

    const title = document.createElement('div')
    title.className = 'slideStrip__title'
    header.appendChild(title)

    const toggle = document.createElement('button')
    toggle.type = 'button'
    toggle.className = 'slideStrip__toggle'
    toggle.addEventListener('click', () => {
      slidesExpanded = !slidesExpanded
      renderSlideStrip(container)
    })
    header.appendChild(toggle)
    root.appendChild(header)

    const grid = document.createElement('div')
    grid.className = 'slideStrip__grid'
    root.appendChild(grid)
    container.prepend(root)
  }

  const root = container.querySelector<HTMLDivElement>('.slideStrip')
  if (!root) return
  root.dataset.sourceId = sourceId
  root.dataset.mode = expectedMode

  const header = root.querySelector<HTMLDivElement>('.slideStrip__header')
  const title = root.querySelector<HTMLDivElement>('.slideStrip__title')
  const toggle = root.querySelector<HTMLButtonElement>('.slideStrip__toggle')
  const grid = root.querySelector<HTMLDivElement>('.slideStrip__grid')
  if (!header || !title || !toggle || !grid) return

  const total = allSlides.length
  title.textContent =
    !slidesExpanded && total > slides.length
      ? `Slides (${total}) · showing ${slides.length}`
      : `Slides (${total})`
  toggle.textContent = slidesExpanded ? 'Collapse' : 'Expand'
  toggle.setAttribute('aria-pressed', slidesExpanded ? 'true' : 'false')
  if (slidesExpanded) {
    grid.classList.add('isExpanded')
  } else {
    grid.classList.remove('isExpanded')
  }

  const existingButtons = new Map<number, HTMLButtonElement>()
  for (const button of Array.from(grid.querySelectorAll<HTMLButtonElement>('.slideStrip__item'))) {
    const idxRaw = button.dataset.slideIndex
    const idx = idxRaw ? Number(idxRaw) : Number.NaN
    if (!Number.isFinite(idx)) continue
    existingButtons.set(idx, button)
  }

  const wanted = new Set<number>(slides.map((slide) => slide.index))
  for (const [idx, button] of existingButtons) {
    if (wanted.has(idx)) continue
    button.remove()
    existingButtons.delete(idx)
  }

  for (const slide of slides) {
    const idx = slide.index
    let button = existingButtons.get(idx)
    if (!button) {
      button = document.createElement('button')
      button.type = 'button'
      button.className = 'slideStrip__item'
      button.dataset.slideIndex = String(idx)

      const thumb = document.createElement('div')
      thumb.className = 'slideStrip__thumb'
      const img = document.createElement('img')
      img.alt = `Slide ${idx}`
      img.className = 'slideStrip__thumbImage'
      thumb.appendChild(img)

      const meta = document.createElement('div')
      meta.className = 'slideStrip__meta'

      button.appendChild(thumb)
      button.appendChild(meta)
      grid.appendChild(button)
      existingButtons.set(idx, button)
    }

    const thumb = button.querySelector<HTMLDivElement>('.slideStrip__thumb')
    const img = button.querySelector<HTMLImageElement>('img.slideStrip__thumbImage')
    const meta = button.querySelector<HTMLDivElement>('.slideStrip__meta')
    if (!thumb || !img || !meta) continue

    updateSlideThumb(img, thumb, slide.imageUrl)
    updateSlideMeta(meta, idx, slide.timestamp, slideTitleByIndex.get(idx) ?? null, slides.length)

    const existingText = button.querySelector<HTMLDivElement>('.slideStrip__text')
    if (slidesExpanded) {
      if (!existingText) {
        const description = document.createElement('div')
        description.className = 'slideStrip__text'
        button.appendChild(description)
      }
      const textEl = button.querySelector<HTMLDivElement>('.slideStrip__text')
      if (textEl) textEl.textContent = slideDescriptions.get(idx) ?? ''
    } else if (existingText) {
      existingText.remove()
    }

    bindSlideSeek(button, slide.timestamp)
  }
}

function renderSlideGallery(container: HTMLElement) {
  if (slidesLayoutValue !== 'gallery') {
    clearSlideGallery(container)
    return
  }
  if (!panelState.slides) {
    clearSlideGallery(container)
    return
  }
  const slides = panelState.slides.slides
  if (slides.length === 0) {
    clearSlideGallery(container)
    return
  }

  const sourceId = panelState.slides.sourceId
  let root = container.querySelector<HTMLDivElement>('.slideGallery')
  if (!root || root.dataset.sourceId !== sourceId) {
    clearSlideGallery(container)
    root = document.createElement('div')
    root.className = 'slideGallery'
    root.dataset.sourceId = sourceId

    const header = document.createElement('div')
    header.className = 'slideGallery__header'
    const title = document.createElement('div')
    title.className = 'slideGallery__title'
    header.appendChild(title)
    root.appendChild(header)

    const list = document.createElement('div')
    list.className = 'slideGallery__list'
    root.appendChild(list)

    container.prepend(root)
  }

  const title = root.querySelector<HTMLDivElement>('.slideGallery__title')
  const list = root.querySelector<HTMLDivElement>('.slideGallery__list')
  if (!title || !list) return
  title.textContent = `Slides (${slides.length})`

  const existingItems = new Map<number, HTMLElement>()
  for (const item of Array.from(list.querySelectorAll<HTMLElement>('.slideGallery__item'))) {
    const idxRaw = item.dataset.slideIndex
    const idx = idxRaw ? Number(idxRaw) : Number.NaN
    if (!Number.isFinite(idx)) continue
    existingItems.set(idx, item)
  }

  const wanted = new Set<number>(slides.map((slide) => slide.index))
  for (const [idx, item] of existingItems) {
    if (wanted.has(idx)) continue
    item.remove()
    existingItems.delete(idx)
  }

  for (const slide of slides) {
    const idx = slide.index
    let item = existingItems.get(idx)
    if (!item) {
      item = document.createElement('button')
      item.type = 'button'
      item.className = 'slideGallery__item'
      item.dataset.slideIndex = String(idx)

      const media = document.createElement('div')
      media.className = 'slideGallery__media'

      const thumb = document.createElement('div')
      thumb.className = 'slideInline__thumb slideGallery__thumb isPlaceholder'
      const img = document.createElement('img')
      img.alt = `Slide ${idx}`
      img.className = 'slideInline__thumbImage'
      thumb.appendChild(img)
      media.appendChild(thumb)

      const body = document.createElement('div')
      body.className = 'slideGallery__body'
      const meta = document.createElement('div')
      meta.className = 'slideGallery__meta'
      const text = document.createElement('div')
      text.className = 'slideGallery__text'
      body.append(meta, text)

      item.append(media, body)
      list.appendChild(item)
      existingItems.set(idx, item)
    }

    const media = item.querySelector<HTMLDivElement>('.slideGallery__media')
    const img = item.querySelector<HTMLImageElement>('img.slideInline__thumbImage')
    const thumb = item.querySelector<HTMLDivElement>('.slideGallery__thumb')
    const meta = item.querySelector<HTMLDivElement>('.slideGallery__meta')
    const text = item.querySelector<HTMLDivElement>('.slideGallery__text')
    if (!media || !img || !thumb || !meta || !text) continue

    updateSlideThumb(img, thumb, slide.imageUrl)
    updateSlideMeta(meta, idx, slide.timestamp, slideTitleByIndex.get(idx) ?? null, slides.length)
    text.textContent = slideDescriptions.get(idx) ?? ''

    bindSlideSeek(item, slide.timestamp)
    list.appendChild(item)
  }
}

function stripSlidePlaceholders(container: HTMLElement) {
  const placeholders = Array.from(container.querySelectorAll('span.slideInline'))
  for (const placeholder of placeholders) {
    placeholder.remove()
  }
}

function renderInlineSlides(container: HTMLElement, opts?: { fallback?: boolean }) {
  const isSummary = container === renderMarkdownHostEl
  if (isSummary) {
    stripSlidePlaceholders(container)
    if (opts?.fallback) queueSlidesRender()
    return
  }
  if (!panelState.slides) {
    if (opts?.fallback) clearSlideStrip(renderSlidesHostEl)
    return
  }
  const slidesByIndex = new Map(panelState.slides.slides.map((slide) => [slide.index, slide]))
  const slideTotal = panelState.slides.slides.length || slidesByIndex.size
  const placeholders = Array.from(container.querySelectorAll('span.slideInline'))
  let replacedCount = 0
  for (const placeholder of placeholders) {
    const indexAttr = placeholder.getAttribute('data-slide-index')
    const index = indexAttr ? Number(indexAttr) : Number.NaN
    const slide = slidesByIndex.get(index)
    if (!slide) continue
    const wrapper = document.createElement('div')
    wrapper.className = 'slideInline'
    wrapper.dataset.slideIndex = String(index)
    const button = document.createElement('button')
    button.type = 'button'
    const thumb = document.createElement('div')
    thumb.className = 'slideInline__thumb isPlaceholder'
    const img = document.createElement('img')
    img.alt = `Slide ${index}`
    img.className = 'slideInline__thumbImage'
    updateSlideThumb(img, thumb, slide.imageUrl)
    const caption = document.createElement('div')
    caption.className = 'slideCaption'
    updateSlideMeta(
      caption,
      index,
      slide.timestamp,
      slideTitleByIndex.get(index) ?? null,
      slideTotal
    )
    thumb.appendChild(img)
    button.appendChild(thumb)
    button.appendChild(caption)
    bindSlideSeek(button, slide.timestamp)
    wrapper.appendChild(button)
    placeholder.replaceWith(wrapper)
    replacedCount += 1
  }
  if (opts?.fallback) {
    if (replacedCount === 0) {
      queueSlidesRender()
    }
  }
}

function getLineHeightPx(el: HTMLElement, styles?: CSSStyleDeclaration): number {
  const resolved = styles ?? getComputedStyle(el)
  const lineHeightRaw = resolved.lineHeight
  const fontSize = Number.parseFloat(resolved.fontSize) || 0
  if (lineHeightRaw === 'normal') return fontSize * 1.2
  const parsed = Number.parseFloat(lineHeightRaw)
  return Number.isFinite(parsed) ? parsed : 0
}

function elementWrapsToMultipleLines(el: HTMLElement): boolean {
  if (el.getClientRects().length === 0) return false
  const styles = getComputedStyle(el)
  const lineHeight = getLineHeightPx(el, styles)
  if (!lineHeight) return false

  const paddingTop = Number.parseFloat(styles.paddingTop) || 0
  const paddingBottom = Number.parseFloat(styles.paddingBottom) || 0
  const borderTop = Number.parseFloat(styles.borderTopWidth) || 0
  const borderBottom = Number.parseFloat(styles.borderBottomWidth) || 0
  const totalHeight = el.getBoundingClientRect().height
  const contentHeight = Math.max(
    0,
    totalHeight - paddingTop - paddingBottom - borderTop - borderBottom
  )

  return contentHeight > lineHeight * 1.4
}

type MetricsMode = 'summary' | 'chat'

type MetricsState = {
  summary: string | null
  inputSummary: string | null
  sourceUrl: string | null
}

type MetricsRenderState = {
  summary: string | null
  inputSummary: string | null
  sourceUrl: string | null
  shortened: boolean
  rafId: number | null
  observer: ResizeObserver | null
}

const metricsRenderState: MetricsRenderState = {
  summary: null,
  inputSummary: null,
  sourceUrl: null,
  shortened: false,
  rafId: null,
  observer: null,
}

const metricsByMode: Record<MetricsMode, MetricsState> = {
  summary: { summary: null, inputSummary: null, sourceUrl: null },
  chat: { summary: null, inputSummary: null, sourceUrl: null },
}

let activeMetricsMode: MetricsMode = 'summary'

let metricsMeasureEl: HTMLDivElement | null = null

function ensureMetricsMeasureEl(): HTMLDivElement {
  if (metricsMeasureEl) return metricsMeasureEl
  const el = document.createElement('div')
  el.style.position = 'absolute'
  el.style.visibility = 'hidden'
  el.style.pointerEvents = 'none'
  el.style.left = '-99999px'
  el.style.top = '0'
  el.style.padding = '0'
  el.style.border = '0'
  el.style.margin = '0'
  el.style.whiteSpace = 'normal'
  el.style.boxSizing = 'content-box'
  document.body.append(el)
  metricsMeasureEl = el
  return el
}

function syncMetricsMeasureStyles() {
  if (!metricsMeasureEl) return
  const styles = getComputedStyle(metricsEl)
  metricsMeasureEl.style.fontFamily = styles.fontFamily
  metricsMeasureEl.style.fontSize = styles.fontSize
  metricsMeasureEl.style.fontWeight = styles.fontWeight
  metricsMeasureEl.style.fontStyle = styles.fontStyle
  metricsMeasureEl.style.fontVariant = styles.fontVariant
  metricsMeasureEl.style.lineHeight = styles.lineHeight
  metricsMeasureEl.style.letterSpacing = styles.letterSpacing
  metricsMeasureEl.style.wordSpacing = styles.wordSpacing
  metricsMeasureEl.style.textTransform = styles.textTransform
  metricsMeasureEl.style.textIndent = styles.textIndent
  metricsMeasureEl.style.wordBreak = styles.wordBreak
  metricsMeasureEl.style.whiteSpace = styles.whiteSpace
  metricsMeasureEl.style.width = `${metricsEl.clientWidth}px`
}

function ensureMetricsObserver() {
  if (metricsRenderState.observer) return
  metricsRenderState.observer = new ResizeObserver(() => {
    scheduleMetricsFitCheck()
  })
  metricsRenderState.observer.observe(metricsEl)
}

function scheduleMetricsFitCheck() {
  if (!metricsRenderState.summary) return
  if (metricsRenderState.rafId != null) return
  metricsRenderState.rafId = window.requestAnimationFrame(() => {
    metricsRenderState.rafId = null
    if (!metricsRenderState.summary) return
    const parts = buildMetricsParts({
      summary: metricsRenderState.summary,
      inputSummary: metricsRenderState.inputSummary,
    })
    if (parts.length === 0) return
    const fullText = parts.join(' · ')
    if (!/\bopenrouter\//i.test(fullText)) return
    if (metricsEl.clientWidth <= 0) return
    const measureEl = ensureMetricsMeasureEl()
    syncMetricsMeasureStyles()
    measureEl.textContent = fullText
    const shouldShorten = elementWrapsToMultipleLines(measureEl)
    if (shouldShorten === metricsRenderState.shortened) return
    metricsRenderState.shortened = shouldShorten
    renderMetricsSummary(metricsRenderState.summary, {
      shortenOpenRouter: shouldShorten,
      inputSummary: metricsRenderState.inputSummary,
      sourceUrl: metricsRenderState.sourceUrl,
    })
  })
}

function renderMetricsSummary(
  summary: string,
  options?: { shortenOpenRouter?: boolean; inputSummary?: string | null; sourceUrl?: string | null }
) {
  metricsEl.replaceChildren()
  const tokens = buildMetricsTokens({
    summary,
    inputSummary: options?.inputSummary ?? panelState.lastMeta.inputSummary,
    sourceUrl: options?.sourceUrl ?? panelState.currentSource?.url ?? null,
    shortenOpenRouter: options?.shortenOpenRouter ?? false,
  })

  tokens.forEach((token, index) => {
    if (index) metricsEl.append(document.createTextNode(' · '))
    if (token.kind === 'link') {
      const link = document.createElement('a')
      link.href = token.href
      link.textContent = token.text
      link.target = '_blank'
      link.rel = 'noopener noreferrer'
      metricsEl.append(link)
      return
    }
    if (token.kind === 'media') {
      if (token.before) metricsEl.append(document.createTextNode(token.before))
      const link = document.createElement('a')
      link.href = token.href
      link.textContent = token.label
      link.target = '_blank'
      link.rel = 'noopener noreferrer'
      metricsEl.append(link)
      if (token.after) metricsEl.append(document.createTextNode(token.after))
      return
    }
    metricsEl.append(document.createTextNode(token.text))
  })
}

function moveMetricsTo(mode: MetricsMode) {
  const target = mode === 'chat' ? chatMetricsSlotEl : metricsHomeEl
  if (metricsEl.parentElement !== target) {
    target.append(metricsEl)
  }
  activeMetricsMode = mode
}

function renderMetricsMode(mode: MetricsMode) {
  const state = metricsByMode[mode]
  metricsRenderState.summary = state.summary
  metricsRenderState.inputSummary = state.inputSummary
  metricsRenderState.sourceUrl = state.sourceUrl
  metricsRenderState.shortened = false

  if (mode === 'chat') {
    chatMetricsSlotEl.classList.toggle('isVisible', Boolean(state.summary))
  } else {
    chatMetricsSlotEl.classList.remove('isVisible')
  }

  metricsEl.removeAttribute('title')
  metricsEl.removeAttribute('data-details')

  if (!state.summary) {
    metricsEl.textContent = ''
    metricsEl.classList.add('hidden')
    return
  }

  renderMetricsSummary(state.summary, {
    inputSummary: state.inputSummary,
    sourceUrl: state.sourceUrl,
  })
  metricsEl.classList.remove('hidden')
  ensureMetricsObserver()
  scheduleMetricsFitCheck()
}

function setMetricsForMode(
  mode: MetricsMode,
  summary: string | null,
  inputSummary: string | null,
  sourceUrl: string | null
) {
  metricsByMode[mode] = { summary, inputSummary, sourceUrl }
  if (activeMetricsMode === mode) {
    renderMetricsMode(mode)
  }
}

function clearMetricsForMode(mode: MetricsMode) {
  setMetricsForMode(mode, null, null, null)
}

function setActiveMetricsMode(mode: MetricsMode) {
  moveMetricsTo(mode)
  renderMetricsMode(mode)
}

function applyTypography(fontFamily: string, fontSize: number, lineHeight: number) {
  document.documentElement.style.setProperty('--font-body', fontFamily)
  document.documentElement.style.setProperty('--font-size', `${fontSize}px`)
  document.documentElement.style.setProperty('--line-height', `${lineHeight}`)
}

const MIN_FONT_SIZE = 12
const MAX_FONT_SIZE = 20
let currentFontSize = defaultSettings.fontSize
const MIN_LINE_HEIGHT = 1.2
const MAX_LINE_HEIGHT = 1.9
const LINE_HEIGHT_STEP = 0.1
let currentLineHeight = defaultSettings.lineHeight

function clampFontSize(value: number) {
  return Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, Math.round(value)))
}

function updateSizeControls() {
  sizeSmBtn.disabled = currentFontSize <= MIN_FONT_SIZE
  sizeLgBtn.disabled = currentFontSize >= MAX_FONT_SIZE
}

function setCurrentFontSize(value: number) {
  currentFontSize = clampFontSize(value)
  updateSizeControls()
}

function clampLineHeight(value: number) {
  const rounded = Math.round(value * 10) / 10
  return Math.min(MAX_LINE_HEIGHT, Math.max(MIN_LINE_HEIGHT, rounded))
}

function updateLineHeightControls() {
  lineTightBtn.disabled = currentLineHeight <= MIN_LINE_HEIGHT
  lineLooseBtn.disabled = currentLineHeight >= MAX_LINE_HEIGHT
}

function setCurrentLineHeight(value: number) {
  currentLineHeight = clampLineHeight(value)
  updateLineHeightControls()
}

let pickerSettings = {
  scheme: defaultSettings.colorScheme,
  mode: defaultSettings.colorMode,
  fontFamily: defaultSettings.fontFamily,
  length: defaultSettings.length,
}

const pickerHandlers = {
  onSchemeChange: (value) => {
    void (async () => {
      const next = await patchSettings({ colorScheme: value })
      pickerSettings = { ...pickerSettings, scheme: next.colorScheme, mode: next.colorMode }
      applyTheme({ scheme: next.colorScheme, mode: next.colorMode })
    })()
  },
  onModeChange: (value) => {
    void (async () => {
      const next = await patchSettings({ colorMode: value })
      pickerSettings = { ...pickerSettings, scheme: next.colorScheme, mode: next.colorMode }
      applyTheme({ scheme: next.colorScheme, mode: next.colorMode })
    })()
  },
  onFontChange: (value) => {
    void (async () => {
      const next = await patchSettings({ fontFamily: value })
      pickerSettings = { ...pickerSettings, fontFamily: next.fontFamily }
      applyTypography(next.fontFamily, next.fontSize, next.lineHeight)
      setCurrentFontSize(next.fontSize)
      setCurrentLineHeight(next.lineHeight)
    })()
  },
  onLengthChange: (value) => {
    pickerSettings = { ...pickerSettings, length: value }
    void send({ type: 'panel:setLength', value })
  },
}

const pickers = mountSidepanelPickers(pickersRoot, {
  scheme: pickerSettings.scheme,
  mode: pickerSettings.mode,
  fontFamily: pickerSettings.fontFamily,
  onSchemeChange: pickerHandlers.onSchemeChange,
  onModeChange: pickerHandlers.onModeChange,
  onFontChange: pickerHandlers.onFontChange,
})

const lengthPicker = mountSidepanelLengthPicker(lengthRoot, {
  length: pickerSettings.length,
  onLengthChange: pickerHandlers.onLengthChange,
})

const autoToggle = mountCheckbox(autoToggleRoot, {
  id: 'sidepanel-auto',
  label: 'Auto summarize',
  checked: autoValue,
  onCheckedChange: (checked) => {
    autoValue = checked
    void send({ type: 'panel:setAuto', value: checked })
  },
})

function applyChatEnabled() {
  chatContainerEl.toggleAttribute('hidden', !chatEnabledValue)
  chatDockEl.toggleAttribute('hidden', !chatEnabledValue)
  if (!chatEnabledValue) {
    chatJumpBtn.classList.remove('isVisible')
  }
  if (!chatEnabledValue) {
    clearMetricsForMode('chat')
    resetChatState()
    clearQueuedMessages()
  } else {
    renderEl.classList.remove('hidden')
  }
}

function getChatHistoryKey(tabId: number) {
  return `chat:tab:${tabId}`
}

function buildEmptyUsage() {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  }
}

function normalizeStoredMessage(raw: Record<string, unknown>): ChatMessage | null {
  const role = raw.role
  const timestamp = typeof raw.timestamp === 'number' ? raw.timestamp : Date.now()
  const id = typeof raw.id === 'string' ? raw.id : crypto.randomUUID()

  if (role === 'user') {
    const content = raw.content
    if (typeof content !== 'string' && !Array.isArray(content)) return null
    return { ...(raw as Message), role: 'user', content, timestamp, id }
  }

  if (role === 'assistant') {
    const content = Array.isArray(raw.content)
      ? raw.content
      : typeof raw.content === 'string'
        ? [{ type: 'text', text: raw.content }]
        : []
    return {
      ...(raw as Message),
      role: 'assistant',
      content,
      api: typeof raw.api === 'string' ? raw.api : 'openai-completions',
      provider: typeof raw.provider === 'string' ? raw.provider : 'openai',
      model: typeof raw.model === 'string' ? raw.model : 'unknown',
      usage: typeof raw.usage === 'object' && raw.usage ? raw.usage : buildEmptyUsage(),
      stopReason: typeof raw.stopReason === 'string' ? raw.stopReason : 'stop',
      timestamp,
      id,
    }
  }

  if (role === 'toolResult') {
    const content = Array.isArray(raw.content)
      ? raw.content
      : typeof raw.content === 'string'
        ? [{ type: 'text', text: raw.content }]
        : []
    return {
      ...(raw as Message),
      role: 'toolResult',
      content,
      toolCallId: typeof raw.toolCallId === 'string' ? raw.toolCallId : crypto.randomUUID(),
      toolName: typeof raw.toolName === 'string' ? raw.toolName : 'tool',
      isError: Boolean(raw.isError),
      timestamp,
      id,
    }
  }

  return null
}

async function clearChatHistoryForTab(tabId: number | null) {
  if (!tabId) return
  chatHistoryCache.delete(tabId)
  const store = chrome.storage?.session
  if (!store) return
  try {
    await store.remove(getChatHistoryKey(tabId))
  } catch {
    // ignore
  }
}

async function clearChatHistoryForActiveTab() {
  await clearChatHistoryForTab(activeTabId)
}

async function loadChatHistory(tabId: number): Promise<ChatMessage[] | null> {
  const cached = chatHistoryCache.get(tabId)
  if (cached) return cached
  const store = chrome.storage?.session
  if (!store) return null
  try {
    const key = getChatHistoryKey(tabId)
    const res = await store.get(key)
    const raw = res?.[key]
    if (!Array.isArray(raw)) return null
    const parsed = raw
      .filter((msg) => msg && typeof msg === 'object')
      .map((msg) => normalizeStoredMessage(msg as Record<string, unknown>))
      .filter((msg): msg is ChatMessage => Boolean(msg))
    if (!parsed.length) return null
    chatHistoryCache.set(tabId, parsed)
    return parsed
  } catch {
    return null
  }
}

async function persistChatHistory() {
  if (!chatEnabledValue) return
  const tabId = activeTabId
  if (!tabId) return
  const compacted = compactChatHistory(chatController.getMessages(), chatLimits)
  if (compacted.length !== chatController.getMessages().length) {
    chatController.setMessages(compacted, { scroll: false })
  }
  chatHistoryCache.set(tabId, compacted)
  const store = chrome.storage?.session
  if (!store) return
  try {
    await store.set({ [getChatHistoryKey(tabId)]: compacted })
  } catch {
    // ignore
  }
}

async function restoreChatHistory() {
  const tabId = activeTabId
  if (!tabId) return
  chatHistoryLoadId += 1
  const loadId = chatHistoryLoadId
  const history = await loadChatHistory(tabId)
  if (loadId !== chatHistoryLoadId) return
  if (history?.length) {
    const compacted = compactChatHistory(history, chatLimits)
    chatController.setMessages(compacted, { scroll: false })
    return
  }

  try {
    const response = await requestChatHistory(panelState.summaryMarkdown)
    if (loadId !== chatHistoryLoadId || !response.ok || !Array.isArray(response.messages)) {
      return
    }
    const parsed = response.messages
      .filter((msg) => msg && typeof msg === 'object')
      .map((msg) => normalizeStoredMessage(msg as Record<string, unknown>))
      .filter((msg): msg is ChatMessage => Boolean(msg))
    if (!parsed.length) return
    const compacted = compactChatHistory(parsed, chatLimits)
    chatController.setMessages(compacted, { scroll: false })
    await persistChatHistory()
  } catch {
    // ignore
  }
}

type PlatformKind = 'mac' | 'windows' | 'linux' | 'other'

function resolvePlatformKind(): PlatformKind {
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } }
  const raw = (nav.userAgentData?.platform ?? navigator.platform ?? navigator.userAgent ?? '')
    .toLowerCase()
    .trim()

  if (raw.includes('mac')) return 'mac'
  if (raw.includes('win')) return 'windows'
  if (raw.includes('linux') || raw.includes('cros') || raw.includes('chrome os')) return 'linux'
  return 'other'
}

const platformKind = resolvePlatformKind()

function friendlyFetchError(err: unknown, context: string): string {
  const message = err instanceof Error ? err.message : String(err)
  if (message.toLowerCase() === 'failed to fetch') {
    return `${context}: Failed to fetch (daemon unreachable or blocked by Chrome; try \`summarize daemon status\`, maybe \`summarize daemon restart\`, and check ~/.summarize/logs/daemon.err.log)`
  }
  return `${context}: ${message}`
}

function setModelStatus(text: string, state: 'idle' | 'running' | 'error' | 'ok' = 'idle') {
  modelStatusEl.textContent = text
  if (state === 'idle') {
    modelStatusEl.removeAttribute('data-state')
  } else {
    modelStatusEl.setAttribute('data-state', state)
  }
}

function setDefaultModelPresets() {
  modelPresetEl.innerHTML = ''
  const auto = document.createElement('option')
  auto.value = 'auto'
  auto.textContent = 'Auto'
  modelPresetEl.append(auto)
  const free = document.createElement('option')
  free.value = 'free'
  free.textContent = 'Free'
  modelPresetEl.append(free)
  const custom = document.createElement('option')
  custom.value = 'custom'
  custom.textContent = 'Custom…'
  modelPresetEl.append(custom)
}

function setModelPlaceholderFromDiscovery(discovery: {
  providers?: unknown
  localModelsSource?: unknown
}) {
  const hints: string[] = ['auto']
  const providers = discovery.providers
  if (providers && typeof providers === 'object') {
    const p = providers as Record<string, unknown>
    if (p.openrouter === true) hints.push('free')
    if (p.openai === true) hints.push('openai/…')
    if (p.anthropic === true) hints.push('anthropic/…')
    if (p.google === true) hints.push('google/…')
    if (p.xai === true) hints.push('xai/…')
    if (p.zai === true) hints.push('zai/…')
  }
  if (discovery.localModelsSource && typeof discovery.localModelsSource === 'object') {
    hints.push('local: openai/<id>')
  }
  modelCustomEl.placeholder = hints.join(' / ')
}

function readCurrentModelValue(): string {
  return readPresetOrCustomValue({
    presetValue: modelPresetEl.value,
    customValue: modelCustomEl.value,
    defaultValue: defaultSettings.model,
  })
}

function updateModelRowUI() {
  const isCustom = modelPresetEl.value === 'custom'
  modelCustomEl.hidden = !isCustom
  modelRowEl.classList.toggle('isCustom', isCustom)
  modelRefreshBtn.hidden = modelPresetEl.value !== 'free'
}

function setModelValue(value: string) {
  const next = value.trim() || defaultSettings.model
  const optionValues = new Set(Array.from(modelPresetEl.options).map((o) => o.value))
  if (optionValues.has(next) && next !== 'custom') {
    modelPresetEl.value = next
    updateModelRowUI()
    return
  }
  modelPresetEl.value = 'custom'
  updateModelRowUI()
  modelCustomEl.value = next
}

function captureModelSelection() {
  return {
    presetValue: modelPresetEl.value,
    customValue: modelCustomEl.value,
  }
}

function restoreModelSelection(selection: { presetValue: string; customValue: string }) {
  if (selection.presetValue === 'custom') {
    modelPresetEl.value = 'custom'
    updateModelRowUI()
    modelCustomEl.value = selection.customValue
    return
  }
  const optionValues = new Set(Array.from(modelPresetEl.options).map((o) => o.value))
  if (optionValues.has(selection.presetValue) && selection.presetValue !== 'custom') {
    modelPresetEl.value = selection.presetValue
    updateModelRowUI()
    return
  }
  setModelValue(selection.presetValue)
}

async function refreshModelPresets(token: string) {
  const selection = captureModelSelection()
  const trimmed = token.trim()
  if (!trimmed) {
    setDefaultModelPresets()
    setModelPlaceholderFromDiscovery({})
    restoreModelSelection(selection)
    return
  }
  try {
    const res = await fetch('http://127.0.0.1:8787/v1/models', {
      headers: { Authorization: `Bearer ${trimmed}` },
    })
    if (!res.ok) {
      setDefaultModelPresets()
      restoreModelSelection(selection)
      return
    }
    const json = (await res.json()) as unknown
    if (!json || typeof json !== 'object') return
    const obj = json as Record<string, unknown>
    if (obj.ok !== true) return

    setModelPlaceholderFromDiscovery({
      providers: obj.providers,
      localModelsSource: obj.localModelsSource,
    })

    const optionsRaw = obj.options
    if (!Array.isArray(optionsRaw)) return

    const options = optionsRaw
      .map((item) => {
        if (!item || typeof item !== 'object') return null
        const record = item as { id?: unknown; label?: unknown }
        const id = typeof record.id === 'string' ? record.id.trim() : ''
        const label = typeof record.label === 'string' ? record.label.trim() : ''
        if (!id) return null
        return { id, label }
      })
      .filter((x): x is { id: string; label: string } => x !== null)

    if (options.length === 0) {
      setDefaultModelPresets()
      restoreModelSelection(selection)
      return
    }

    setDefaultModelPresets()
    const seen = new Set(Array.from(modelPresetEl.options).map((o) => o.value))
    for (const opt of options) {
      if (seen.has(opt.id)) continue
      seen.add(opt.id)
      const el = document.createElement('option')
      el.value = opt.id
      el.textContent = opt.label ? `${opt.id} — ${opt.label}` : opt.id
      modelPresetEl.append(el)
    }
    restoreModelSelection(selection)
  } catch {
    // ignore
  }
}

let modelRefreshAt = 0
const refreshModelsIfStale = () => {
  const now = Date.now()
  if (now - modelRefreshAt < 1500) return
  modelRefreshAt = now
  void (async () => {
    const token = (await loadSettings()).token
    await refreshModelPresets(token)
  })()
}

let refreshFreeRunning = false

async function runRefreshFree() {
  if (refreshFreeRunning) return
  const token = (await loadSettings()).token.trim()
  if (!token) {
    setModelStatus('Setup required (missing token).', 'error')
    return
  }
  refreshFreeRunning = true
  modelRefreshBtn.disabled = true
  setModelStatus('Starting scan…', 'running')
  let winnerModel: string | null = null

  try {
    const res = await fetch('http://127.0.0.1:8787/v1/refresh-free', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({}),
    })
    const json = (await res.json()) as { ok?: boolean; id?: string; error?: string }
    if (!res.ok || !json.ok || !json.id) {
      throw new Error(json.error || `${res.status} ${res.statusText}`)
    }

    const streamRes = await fetch(`http://127.0.0.1:8787/v1/refresh-free/${json.id}/events`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    if (!streamRes.ok) throw new Error(`${streamRes.status} ${streamRes.statusText}`)
    if (!streamRes.body) throw new Error('Missing stream body')

    for await (const raw of parseSseStream(streamRes.body)) {
      const event = parseSseEvent(raw)
      if (!event) continue
      if (event.event === 'status') {
        const text = event.data.text.trim()
        if (text) {
          if (!winnerModel) {
            const match = text.match(/^-\\s+([^\\s]+)/)
            if (match?.[1]) winnerModel = match[1]
          }
          setModelStatus(text, 'running')
        }
      } else if (event.event === 'error') {
        throw new Error(event.data.message)
      } else if (event.event === 'done') {
        break
      }
    }

    const winnerNote = winnerModel ? ` Top: ${winnerModel}` : ''
    setModelStatus(`Free models updated.${winnerNote}`, 'ok')
    await refreshModelPresets(token)
  } catch (err) {
    setModelStatus(friendlyFetchError(err, 'Refresh free failed'), 'error')
  } finally {
    refreshFreeRunning = false
    modelRefreshBtn.disabled = false
  }
}

function handleSlidesStatus(text: string) {
  const trimmed = text.trim()
  if (!trimmed) return
  if (!/^slides?/i.test(trimmed)) return
  setSlidesBusy(true)
  if (panelState.phase === 'connecting' || panelState.phase === 'streaming') return
  headerController.setStatus(trimmed)
}

function startSlidesStreamForRunId(runId: string) {
  const effectiveInputMode = inputModeOverride ?? inputMode
  if (!slidesEnabledValue || effectiveInputMode !== 'video') {
    stopSlidesStream()
    return
  }
  hideSlideNotice()
  setSlidesBusy(true)
  panelState.slidesRunId = runId
  panelCacheController.scheduleSync()
  void slidesHydrator.start(runId)
}

function startSlidesStream(run: RunStart) {
  startSlidesStreamForRunId(run.id)
}

const slidesHydrator = createSlidesHydrator({
  getToken: async () => (await loadSettings()).token,
  onSlides: (data) => {
    applySlidesPayload(data)
  },
  onStatus: (text) => {
    handleSlidesStatus(text)
  },
  onError: (err) => {
    const message = friendlyFetchError(err, 'Slides stream failed')
    showSlideNotice(message)
    return message
  },
  onSnapshotError: (err) => {
    const message = err instanceof Error ? err.message : String(err)
    console.debug('[summarize] slides snapshot failed', message)
  },
  onDone: () => {
    setSlidesBusy(false)
    if (panelState.phase === 'idle') {
      headerController.setStatus('')
    }
  },
})

const streamController = createStreamController({
  getToken: async () => (await loadSettings()).token,
  onReset: () => {
    const preserveChat = preserveChatOnNextReset
    preserveChatOnNextReset = false
    resetSummaryView({ preserveChat, clearRunId: false })
    panelState.lastMeta = { inputSummary: null, model: null, modelLabel: null }
    lastStreamError = null
    if (pendingRunForPlannedSlides) {
      seedPlannedSlidesForRun(pendingRunForPlannedSlides)
      pendingRunForPlannedSlides = null
    }
  },
  onStatus: (text) => {
    headerController.setStatus(text)
    const trimmed = text.trim()
    const isSlideStatus = /^slides?/i.test(trimmed)
    if (isSlideStatus) setSlidesBusy(true)
  },
  onBaseTitle: (text) => headerController.setBaseTitle(text),
  onBaseSubtitle: (text) => headerController.setBaseSubtitle(text),
  onPhaseChange: (phase) => {
    if (phase === 'error') {
      setPhase('error', { error: lastStreamError ?? panelState.error })
    } else {
      setPhase(phase)
    }
    if (phase === 'idle' && panelState.slides && slideSummaryByIndex.size === 0) {
      rebuildSlideDescriptions()
      queueSlidesRender()
    }
  },
  onRememberUrl: (url) => void send({ type: 'panel:rememberUrl', url }),
  onMeta: (data) => {
    panelState.lastMeta = {
      model: typeof data.model === 'string' ? data.model : panelState.lastMeta.model,
      modelLabel:
        typeof data.modelLabel === 'string' ? data.modelLabel : panelState.lastMeta.modelLabel,
      inputSummary:
        typeof data.inputSummary === 'string'
          ? data.inputSummary
          : panelState.lastMeta.inputSummary,
    }
    headerController.setBaseSubtitle(
      buildIdleSubtitle({
        inputSummary: panelState.lastMeta.inputSummary,
        modelLabel: panelState.lastMeta.modelLabel,
        model: panelState.lastMeta.model,
      })
    )
    panelCacheController.scheduleSync()
  },
  onSlides: (data) => {
    slidesHydrator.handlePayload(data)
  },
  onSummaryFromCache: (value) => {
    panelState.summaryFromCache = value
    slidesHydrator.handleSummaryFromCache(value)
    panelCacheController.scheduleSync()
    if (value === true) {
      headerController.stopProgress()
    } else if (value === false && isStreaming()) {
      headerController.armProgress()
    }
  },
  onMetrics: (summary) => {
    setMetricsForMode(
      'summary',
      summary,
      panelState.lastMeta.inputSummary,
      panelState.currentSource?.url ?? null
    )
    setActiveMetricsMode('summary')
  },
  onRender: renderMarkdown,
  onSyncWithActiveTab: syncWithActiveTab,
  onError: (err) => {
    const message = friendlyFetchError(err, 'Stream failed')
    lastStreamError = message
    return message
  },
})

async function ensureToken(): Promise<string> {
  const settings = await loadSettings()
  if (settings.token.trim()) return settings.token.trim()
  const token = generateToken()
  await patchSettings({ token })
  return token
}

function installStepsHtml({
  token,
  headline,
  message,
  showTroubleshooting,
}: {
  token: string
  headline: string
  message?: string
  showTroubleshooting?: boolean
}) {
  const npmCmd = 'npm i -g @steipete/summarize'
  const brewCmd = 'brew install steipete/tap/summarize'
  const daemonCmd = `summarize daemon install --token ${token}`
  const isMac = platformKind === 'mac'
  const isLinux = platformKind === 'linux'
  const isWindows = platformKind === 'windows'
  const isSupported = isMac || isLinux || isWindows
  const daemonLabel = isMac
    ? 'LaunchAgent'
    : isLinux
      ? 'systemd user service'
      : isWindows
        ? 'Scheduled Task'
        : 'daemon'

  const installToggle = isMac
    ? `
      <div class="setup__toggle" role="tablist" aria-label="Install method">
        <button class="setup__pill" type="button" data-install="npm" role="tab" aria-selected="false">NPM</button>
        <button class="setup__pill" type="button" data-install="brew" role="tab" aria-selected="false">Homebrew</button>
      </div>
    `
    : ''

  const installIntro = `
    <div class="setup__section">
      <div class="setup__headerRow">
        <p class="setup__title" data-install-title><strong>1) Install summarize</strong></p>
        ${installToggle}
      </div>
      <div class="setup__codeRow">
        <code data-install-code>${isMac ? brewCmd : npmCmd}</code>
        <button class="ghost icon setup__copy" type="button" data-copy="install" aria-label="Copy install command">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M8 6a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2h-8a2 2 0 0 1-2-2V6Zm-4 4a2 2 0 0 1 2-2h1v2H6v8h8v1a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-9Z" />
          </svg>
        </button>
      </div>
      <p class="setup__hint" data-install-hint>${
        isMac
          ? 'Homebrew installs the daemon-ready binary (macOS arm64).'
          : 'Homebrew tap is macOS-only.'
      }</p>
    </div>
  `

  const daemonIntro = isSupported
    ? `
      <div class="setup__section">
        <p class="setup__title"><strong>2) Register the daemon (${daemonLabel})</strong></p>
        <div class="setup__codeRow">
          <code data-daemon-code>${daemonCmd}</code>
          <button class="ghost icon setup__copy" type="button" data-copy="daemon" aria-label="Copy daemon command">
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M8 6a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2h-8a2 2 0 0 1-2-2V6Zm-4 4a2 2 0 0 1 2-2h1v2H6v8h8v1a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-9Z" />
            </svg>
          </button>
        </div>
      </div>
    `
    : `
      <div class="setup__section">
        <p class="setup__title"><strong>2) Daemon auto-start</strong></p>
        <p class="setup__hint">Not supported on this OS yet.</p>
      </div>
    `

  const troubleshooting =
    showTroubleshooting && isSupported
      ? `
      <div class="setup__section">
        <p class="setup__title"><strong>Troubleshooting</strong></p>
        <div class="setup__codeRow">
          <code>summarize daemon status</code>
          <button class="ghost icon setup__copy" type="button" data-copy="status" aria-label="Copy status command">
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M8 6a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2h-8a2 2 0 0 1-2-2V6Zm-4 4a2 2 0 0 1 2-2h1v2H6v8h8v1a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-9Z" />
            </svg>
          </button>
        </div>
        <p class="setup__hint">Shows daemon health, version, and token auth status.</p>
        <div class="setup__codeRow">
          <code>summarize daemon restart</code>
          <button class="ghost icon setup__copy" type="button" data-copy="restart" aria-label="Copy restart command">
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M8 6a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2h-8a2 2 0 0 1-2-2V6Zm-4 4a2 2 0 0 1 2-2h1v2H6v8h8v1a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-9Z" />
            </svg>
          </button>
        </div>
        <p class="setup__hint">Restarts the daemon if it’s stuck or not responding.</p>
      </div>
    `
      : ''

  return `
    <h2>${headline}</h2>
    ${message ? `<p>${message}</p>` : ''}
    ${installIntro}
    ${daemonIntro}
    <div class="setup__section setup__actions">
      <button id="regen" type="button" class="ghost">Regenerate Token</button>
    </div>
    ${troubleshooting}
  `
}

function wireSetupButtons({
  token,
  showTroubleshooting,
}: {
  token: string
  showTroubleshooting?: boolean
}) {
  const npmCmd = 'npm i -g @steipete/summarize'
  const brewCmd = 'brew install steipete/tap/summarize'
  const daemonCmd = `summarize daemon install --token ${token}`
  const isMac = platformKind === 'mac'
  const installMethodKey = 'summarize.installMethod'
  type InstallMethod = 'npm' | 'brew'
  const resolveInstallMethod = (): InstallMethod => {
    if (!isMac) return 'npm'
    try {
      const stored = localStorage.getItem(installMethodKey)
      if (stored === 'npm' || stored === 'brew') return stored
    } catch {
      // ignore
    }
    return 'brew'
  }
  const persistInstallMethod = (method: InstallMethod) => {
    if (!isMac) return
    try {
      localStorage.setItem(installMethodKey, method)
    } catch {
      // ignore
    }
  }

  const flashCopied = () => {
    headerController.setStatus('Copied')
    setTimeout(() => headerController.setStatus(panelState.ui?.status ?? ''), 800)
  }

  const installTitleEl = setupEl.querySelector<HTMLElement>('[data-install-title]')
  const installCodeEl = setupEl.querySelector<HTMLElement>('[data-install-code]')
  const installHintEl = setupEl.querySelector<HTMLElement>('[data-install-hint]')
  const installButtons = Array.from(setupEl.querySelectorAll<HTMLButtonElement>('[data-install]'))

  const applyInstallMethod = (method: InstallMethod) => {
    const label = method === 'brew' ? 'Homebrew' : 'NPM'
    if (installTitleEl) {
      installTitleEl.innerHTML = `<strong>1) Install summarize (${label})</strong>`
    }
    if (installCodeEl) {
      installCodeEl.textContent = method === 'brew' ? brewCmd : npmCmd
    }
    if (installHintEl) {
      if (!isMac) {
        installHintEl.textContent = 'Homebrew tap is macOS-only.'
      } else if (method === 'brew') {
        installHintEl.textContent = 'Homebrew installs the daemon-ready binary (macOS arm64).'
      } else {
        installHintEl.textContent = 'NPM installs the CLI (requires Node.js).'
      }
    }
    for (const button of installButtons) {
      const isActive = button.dataset.install === method
      button.classList.toggle('isActive', isActive)
      button.setAttribute('aria-selected', isActive ? 'true' : 'false')
    }
    persistInstallMethod(method)
  }

  const currentInstallMethod = resolveInstallMethod()
  applyInstallMethod(currentInstallMethod)

  for (const button of installButtons) {
    button.addEventListener('click', () => {
      const method = button.dataset.install === 'brew' ? 'brew' : 'npm'
      applyInstallMethod(method)
    })
  }

  setupEl.querySelectorAll<HTMLButtonElement>('[data-copy]')?.forEach((button) => {
    button.addEventListener('click', () => {
      void (async () => {
        const copyType = button.dataset.copy
        const installMethod = resolveInstallMethod()
        const payload =
          copyType === 'install'
            ? installMethod === 'brew'
              ? brewCmd
              : npmCmd
            : copyType === 'daemon'
              ? daemonCmd
              : copyType === 'status'
                ? 'summarize daemon status'
                : copyType === 'restart'
                  ? 'summarize daemon restart'
                  : ''
        if (!payload) return
        await navigator.clipboard.writeText(payload)
        flashCopied()
      })()
    })
  })

  setupEl.querySelector<HTMLButtonElement>('#regen')?.addEventListener('click', () => {
    void (async () => {
      const token2 = generateToken()
      await patchSettings({ token: token2 })
      renderSetup(token2)
    })()
  })

  if (!showTroubleshooting) return
}

function renderSetup(token: string) {
  setupEl.classList.remove('hidden')
  setupEl.innerHTML = installStepsHtml({
    token,
    headline: 'Setup',
    message: 'Install summarize, then register the daemon so the side panel can stream summaries.',
  })
  wireSetupButtons({ token })
}

function maybeShowSetup(state: UiState): boolean {
  if (!state.settings.tokenPresent) {
    void (async () => {
      const token = await ensureToken()
      renderSetup(token)
    })()
    return true
  }
  if (!state.daemon.ok || !state.daemon.authed) {
    setupEl.classList.remove('hidden')
    const token = (async () => (await loadSettings()).token.trim())()
    void token.then((t) => {
      setupEl.innerHTML = `
        ${installStepsHtml({
          token: t,
          headline: 'Daemon not reachable',
          message: state.daemon.error ?? 'Check that the LaunchAgent is installed.',
          showTroubleshooting: true,
        })}
      `
      wireSetupButtons({ token: t, showTroubleshooting: true })
    })
    return true
  }
  setupEl.classList.add('hidden')
  return false
}

function updateControls(state: UiState) {
  const nextTabId = state.tab.id ?? null
  const nextTabUrl = state.tab.url ?? null
  const preferUrlMode = nextTabUrl ? shouldPreferUrlMode(nextTabUrl) : false
  const tabChanged = nextTabId !== activeTabId
  const urlChanged =
    !tabChanged && nextTabUrl && activeTabUrl && !urlsMatch(nextTabUrl, activeTabUrl)
  const nextMediaAvailable =
    Boolean(state.media && (state.media.hasVideo || state.media.hasAudio)) || preferUrlMode
  const nextVideoLabel = state.media?.hasAudio && !state.media.hasVideo ? 'Audio' : 'Video'

  if (tabChanged) {
    const preserveChat = isRecentAgentNavigation(nextTabId, nextTabUrl)
    if (preserveChat) {
      notePreserveChatForUrl(nextTabUrl ?? lastAgentNavigation?.url ?? null)
    }
    const previousTabId = activeTabId
    activeTabId = nextTabId
    activeTabUrl = nextTabUrl
    if (panelState.chatStreaming && !preserveChat) {
      requestAgentAbort('Tab changed')
    }
    if (!preserveChat) {
      void clearChatHistoryForActiveTab()
      resetChatState()
    } else {
      void migrateChatHistory(previousTabId, nextTabId)
    }
    inputMode = preferUrlMode ? 'video' : 'page'
    inputModeOverride = null
    if (nextTabId && nextTabUrl) {
      const cached = panelCacheController.resolve(nextTabId, nextTabUrl)
      if (cached) {
        applyPanelCache(cached, { preserveChat })
      } else {
        panelState.currentSource = null
        currentRunTabId = null
        resetSummaryView({ preserveChat })
        panelCacheController.request(nextTabId, nextTabUrl, preserveChat)
      }
    } else {
      panelState.currentSource = null
      currentRunTabId = null
      resetSummaryView({ preserveChat })
    }
  } else if (urlChanged) {
    activeTabUrl = nextTabUrl
    const preserveChat = isRecentAgentNavigation(activeTabId, nextTabUrl)
    if (preserveChat) {
      notePreserveChatForUrl(nextTabUrl)
    } else if (
      chatEnabledValue &&
      (panelState.chatStreaming || chatController.getMessages().length > 0)
    ) {
      void clearChatHistoryForActiveTab()
      resetChatState()
    }
    if (activeTabId && nextTabUrl) {
      const cached = panelCacheController.resolve(activeTabId, nextTabUrl)
      if (cached) {
        applyPanelCache(cached, { preserveChat })
      } else {
        panelState.currentSource = null
        currentRunTabId = null
        resetSummaryView({ preserveChat })
        panelCacheController.request(activeTabId, nextTabUrl, preserveChat)
      }
    } else {
      panelState.currentSource = null
      currentRunTabId = null
      resetSummaryView({ preserveChat })
    }
    if (!inputModeOverride) {
      inputMode = preferUrlMode ? 'video' : 'page'
      inputModeOverride = null
    }
    if (
      chatEnabledValue &&
      nextTabUrl &&
      (panelState.chatStreaming || chatController.getMessages().length > 0)
    ) {
      void appendNavigationMessage(nextTabUrl, state.tab.title ?? null)
    }
  }

  autoValue = state.settings.autoSummarize
  autoToggle.update({
    id: 'sidepanel-auto',
    label: 'Auto summarize',
    checked: autoValue,
    onCheckedChange: (checked) => {
      autoValue = checked
      void send({ type: 'panel:setAuto', value: checked })
    },
  })
  chatEnabledValue = state.settings.chatEnabled
  automationEnabledValue = state.settings.automationEnabled
  slidesEnabledValue = state.settings.slidesEnabled
  slidesParallelValue = state.settings.slidesParallel
  if (state.settings.slidesLayout && state.settings.slidesLayout !== slidesLayoutValue) {
    setSlidesLayout(state.settings.slidesLayout)
  }
  if (!automationEnabledValue) hideAutomationNotice()
  if (!slidesEnabledValue) hideSlideNotice()
  applyChatEnabled()
  if (chatEnabledValue && activeTabId && chatController.getMessages().length === 0) {
    void restoreChatHistory()
  }
  if (pickerSettings.length !== state.settings.length) {
    pickerSettings = { ...pickerSettings, length: state.settings.length }
    lengthPicker.update({
      length: pickerSettings.length,
      onLengthChange: pickerHandlers.onLengthChange,
    })
    rebuildSlideDescriptions()
    if (panelState.summaryMarkdown) {
      renderInlineSlides(renderMarkdownHostEl, { fallback: true })
    }
  }
  if (
    state.settings.fontSize !== currentFontSize ||
    state.settings.lineHeight !== currentLineHeight
  ) {
    applyTypography(pickerSettings.fontFamily, state.settings.fontSize, state.settings.lineHeight)
    setCurrentFontSize(state.settings.fontSize)
    setCurrentLineHeight(state.settings.lineHeight)
  }
  if (readCurrentModelValue() !== state.settings.model) {
    setModelValue(state.settings.model)
  }
  updateModelRowUI()
  modelRefreshBtn.disabled = !state.settings.tokenPresent || refreshFreeRunning
  if (panelState.currentSource) {
    if (state.tab.url && !urlsMatch(state.tab.url, panelState.currentSource.url)) {
      const preserveChat = isRecentAgentNavigation(activeTabId, state.tab.url)
      if (preserveChat) {
        notePreserveChatForUrl(state.tab.url)
      }
      panelState.currentSource = null
      currentRunTabId = null
      streamController.abort()
      resetSummaryView({ preserveChat })
    } else if (state.tab.title && state.tab.title !== panelState.currentSource.title) {
      panelState.currentSource = { ...panelState.currentSource, title: state.tab.title }
      headerController.setBaseTitle(state.tab.title)
    }
  }
  if (!panelState.currentSource) {
    panelState.lastMeta = { inputSummary: null, model: null, modelLabel: null }
    headerController.setBaseTitle(state.tab.title || state.tab.url || 'Summarize')
    headerController.setBaseSubtitle('')
  }
  if (!isStreaming()) {
    headerController.setStatus(state.status)
  }
  if (!nextMediaAvailable) {
    inputMode = 'page'
    inputModeOverride = null
  }
  mediaAvailable = nextMediaAvailable
  summarizeVideoLabel = nextVideoLabel
  summarizePageWords = state.stats.pageWords
  summarizeVideoDurationSeconds = state.stats.videoDurationSeconds
  refreshSummarizeControl()
  const showingSetup = maybeShowSetup(state)
  if (showingSetup && panelState.phase !== 'setup') {
    setPhase('setup')
  } else if (!showingSetup && panelState.phase === 'setup') {
    setPhase('idle')
  }
}

function handleBgMessage(msg: BgToPanel) {
  switch (msg.type) {
    case 'ui:state':
      panelState.ui = msg.state
      updateControls(msg.state)
      return
    case 'ui:status':
      if (!isStreaming()) headerController.setStatus(msg.status)
      return
    case 'run:error':
      headerController.setStatus(
        `Error: ${msg.message && msg.message.trim().length > 0 ? msg.message : 'Something went wrong.'}`
      )
      setPhase('error', {
        error: msg.message && msg.message.trim().length > 0 ? msg.message : 'Something went wrong.',
      })
      if (panelState.chatStreaming) {
        finishStreamingMessage()
      }
      return
    case 'slides:run': {
      if (!msg.ok) {
        setSlidesBusy(false)
        if (msg.error) {
          showSlideNotice(msg.error)
        }
        return
      }
      if (!msg.runId) return
      const targetUrl = msg.url ?? null
      const currentUrl = panelState.currentSource?.url ?? activeTabUrl ?? null
      if (targetUrl && currentUrl && !urlsMatch(targetUrl, currentUrl)) {
        return
      }
      startSlidesStreamForRunId(msg.runId)
      return
    }
    case 'slides:context': {
      if (!panelState.slides) return
      const expectedId = `slides-${slidesContextRequestId}`
      if (msg.requestId !== expectedId) return
      slidesContextPending = false
      if (!msg.ok) {
        setSlidesTranscriptTimedText(null)
        updateSlidesTextState()
        if (panelState.summaryMarkdown) {
          renderInlineSlides(renderMarkdownHostEl, { fallback: true })
        }
        return
      }
      setSlidesTranscriptTimedText(msg.transcriptTimedText ?? null)
      updateSlidesTextState()
      if (panelState.summaryMarkdown) {
        renderInlineSlides(renderMarkdownHostEl, { fallback: true })
      }
      panelCacheController.scheduleSync()
      return
    }
    case 'ui:cache': {
      const result = panelCacheController.consumeResponse(msg)
      if (!result) return
      if (activeTabId !== result.tabId || activeTabUrl !== result.url) return
      if (!result.cache) return
      applyPanelCache(result.cache, { preserveChat: result.preserveChat })
      return
    }
    case 'run:start': {
      stopSlidesStream()
      setPhase('connecting')
      lastAction = 'summarize'
      window.clearTimeout(autoKickTimer)
      if (panelState.chatStreaming) {
        finishStreamingMessage()
      }
      const preserveChat = shouldPreserveChatForRun(msg.run.url)
      if (!preserveChat) {
        void clearChatHistoryForActiveTab()
        resetChatState()
      } else {
        preserveChatOnNextReset = true
      }
      setActiveMetricsMode('summary')
      panelState.runId = msg.run.id
      panelState.slidesRunId = slidesParallelValue ? null : msg.run.id
      panelState.currentSource = { url: msg.run.url, title: msg.run.title }
      currentRunTabId = activeTabId
      panelState.lastMeta = { inputSummary: null, model: null, modelLabel: null }
      pendingRunForPlannedSlides = msg.run
      if (!slidesParallelValue) {
        startSlidesStream(msg.run)
      }
      void streamController.start(msg.run)
      return
    }
    case 'chat:history':
      handleChatHistoryResponse(msg)
      return
    case 'agent:chunk':
      handleAgentChunk(msg)
      return
    case 'agent:response':
      handleAgentResponse(msg)
      return
  }
}

function scheduleAutoKick() {
  if (!autoValue) return
  window.clearTimeout(autoKickTimer)
  autoKickTimer = window.setTimeout(() => {
    if (!autoValue) return
    if (panelState.phase !== 'idle') return
    if (panelState.summaryMarkdown) return
    sendSummarize()
  }, 350)
}

async function send(message: PanelToBg) {
  if (message.type === 'panel:summarize') {
    lastAction = 'summarize'
  } else if (message.type === 'panel:agent') {
    lastAction = 'chat'
  }
  const port = await ensurePanelPort()
  if (!port) return
  try {
    port.postMessage(message)
  } catch {
    // ignore (panel/background race while reloading)
  }
}

function sendSummarize(opts?: { refresh?: boolean }) {
  void send({
    type: 'panel:summarize',
    refresh: Boolean(opts?.refresh),
    inputMode: inputModeOverride ?? undefined,
  })
}

function seedPlannedSlidesForRun(run: RunStart) {
  if (!slidesEnabledValue) return
  const effectiveInputMode = inputModeOverride ?? inputMode
  if (effectiveInputMode !== 'video') return
  const durationSeconds = summarizeVideoDurationSeconds
  if (!durationSeconds || !Number.isFinite(durationSeconds) || durationSeconds <= 0) return

  const normalized = pickerSettings.length.trim().toLowerCase()
  const chunkSeconds =
    normalized === 'short'
      ? 600
      : normalized === 'medium'
        ? 450
        : normalized === 'long'
          ? 300
          : normalized === 'xl'
            ? 180
            : normalized === 'xxl'
              ? 120
              : 300

  const target = Math.max(3, Math.round(durationSeconds / chunkSeconds))
  const count = Math.max(3, Math.min(80, target))

  const youtubeId = extractYouTubeVideoId(run.url)
  const sourceId = youtubeId ?? `planned-${run.id}`
  const sourceKind = youtubeId ? 'youtube' : 'direct'
  const baseImageUrl = youtubeId ? `http://127.0.0.1:8787/v1/slides/${sourceId}` : null

  if (
    panelState.slides &&
    panelState.slides.sourceId === sourceId &&
    panelState.slides.slides.length > 0
  ) {
    return
  }

  const slides = Array.from({ length: count }, (_, i) => {
    const ratio = count <= 1 ? 0 : i / Math.max(1, count - 1)
    const timestamp = Math.max(0, Math.min(durationSeconds - 0.1, ratio * durationSeconds))
    const index = i + 1
    return { index, timestamp, imageUrl: baseImageUrl ? `${baseImageUrl}/${index}` : '' }
  })

  panelState.slides = {
    sourceUrl: run.url,
    sourceId,
    sourceKind,
    ocrAvailable: false,
    slides,
  }
  updateSlidesTextState()
  queueSlidesRender()
}

const timestampPattern = /\[(\d{1,2}:\d{2}(?::\d{2})?)\]/g

function linkifyTimestamps(content: string): string {
  return content.replace(timestampPattern, (match, time) => {
    const seconds = parseTimestampSeconds(time)
    if (seconds == null) return match
    return `[${time}](timestamp:${seconds})`
  })
}

function parseTimestampSeconds(value: string): number | null {
  const parts = value.split(':').map((part) => part.trim())
  if (parts.length < 2 || parts.length > 3) return null
  const secondsPart = parts.pop()
  if (!secondsPart) return null
  const seconds = Number(secondsPart)
  if (!Number.isFinite(seconds) || seconds < 0) return null
  const minutesPart = parts.pop()
  if (minutesPart == null) return null
  const minutes = Number(minutesPart)
  if (!Number.isFinite(minutes) || minutes < 0) return null
  const hoursPart = parts.pop()
  const hours = hoursPart != null ? Number(hoursPart) : 0
  if (!Number.isFinite(hours) || hours < 0) return null
  return Math.floor(hours * 3600 + minutes * 60 + seconds)
}

function parseTimestampHref(href: string): number | null {
  const raw = href.slice('timestamp:'.length).trim()
  const seconds = Number(raw)
  if (!Number.isFinite(seconds) || seconds < 0) return null
  return Math.floor(seconds)
}

function toggleDrawer(force?: boolean, opts?: { animate?: boolean }) {
  const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches ?? false
  const animate = opts?.animate !== false && !reducedMotion

  const isOpen = !drawerEl.classList.contains('hidden')
  const next = typeof force === 'boolean' ? force : !isOpen

  drawerToggleBtn.classList.toggle('isActive', next)
  drawerToggleBtn.setAttribute('aria-expanded', next ? 'true' : 'false')
  drawerEl.setAttribute('aria-hidden', next ? 'false' : 'true')

  if (next === isOpen) return

  const cleanup = () => {
    drawerEl.style.removeProperty('height')
    drawerEl.style.removeProperty('opacity')
    drawerEl.style.removeProperty('transform')
    drawerEl.style.removeProperty('overflow')
  }

  drawerAnimation?.cancel()
  drawerAnimation = null
  cleanup()

  if (!animate) {
    drawerEl.classList.toggle('hidden', !next)
    return
  }

  if (next) {
    drawerEl.classList.remove('hidden')
    const targetHeight = drawerEl.scrollHeight
    drawerEl.style.height = '0px'
    drawerEl.style.opacity = '0'
    drawerEl.style.transform = 'translateY(-6px)'
    drawerEl.style.overflow = 'hidden'

    drawerAnimation = drawerEl.animate(
      [
        { height: '0px', opacity: 0, transform: 'translateY(-6px)' },
        { height: `${targetHeight}px`, opacity: 1, transform: 'translateY(0px)' },
      ],
      { duration: 200, easing: 'cubic-bezier(0.2, 0, 0, 1)' }
    )
    drawerAnimation.onfinish = () => {
      drawerAnimation = null
      cleanup()
    }
    drawerAnimation.oncancel = () => {
      drawerAnimation = null
    }
    return
  }

  const currentHeight = drawerEl.getBoundingClientRect().height
  drawerEl.style.height = `${currentHeight}px`
  drawerEl.style.opacity = '1'
  drawerEl.style.transform = 'translateY(0px)'
  drawerEl.style.overflow = 'hidden'

  drawerAnimation = drawerEl.animate(
    [
      { height: `${currentHeight}px`, opacity: 1, transform: 'translateY(0px)' },
      { height: '0px', opacity: 0, transform: 'translateY(-6px)' },
    ],
    { duration: 180, easing: 'cubic-bezier(0.4, 0, 0.2, 1)' }
  )
  drawerAnimation.onfinish = () => {
    drawerAnimation = null
    drawerEl.classList.add('hidden')
    cleanup()
  }
  drawerAnimation.oncancel = () => {
    drawerAnimation = null
  }
}

function resetChatState() {
  panelState.chatStreaming = false
  chatController.reset()
  clearQueuedMessages()
  chatJumpBtn.classList.remove('isVisible')
  pendingAgentRequests.clear()
  abortAgentRequested = false
  lastNavigationMessageUrl = null
}

function finishStreamingMessage() {
  panelState.chatStreaming = false
  chatSendBtn.disabled = false
  chatInputEl.focus()
  void persistChatHistory()
  maybeSendQueuedChat()
}

async function runAgentLoop() {
  let tools = automationEnabledValue ? getAutomationToolNames() : []
  if (tools.includes('debugger')) {
    const hasDebugger = await chrome.permissions.contains({ permissions: ['debugger'] })
    if (!hasDebugger) {
      tools = tools.filter((tool) => tool !== 'debugger')
    }
  }

  while (true) {
    if (abortAgentRequested) return
    const messages = chatController.buildRequestMessages() as Message[]
    const streamingMessage = buildStreamingAssistantMessage()
    let streamedContent = ''
    chatController.addMessage(streamingMessage)
    scrollToBottom(true)
    let response: AgentResponse
    try {
      response = await requestAgent(messages, tools, panelState.summaryMarkdown, {
        onChunk: (text) => {
          streamedContent += text
          chatController.updateStreamingMessage(streamedContent)
        },
      })
    } catch (error) {
      chatController.removeMessage(streamingMessage.id)
      if (abortAgentRequested) return
      throw error
    }
    if (!response.ok || !response.assistant) {
      chatController.removeMessage(streamingMessage.id)
      throw new Error(response.error || 'Agent failed')
    }

    const assistant = { ...response.assistant, id: streamingMessage.id }
    if (abortAgentRequested) {
      chatController.removeMessage(streamingMessage.id)
      return
    }
    chatController.replaceMessage(assistant)
    chatController.finishStreamingMessage()
    scrollToBottom(true)

    const toolCalls = assistant.content.filter((part) => part.type === 'toolCall') as ToolCall[]
    if (toolCalls.length === 0) break

    for (const call of toolCalls) {
      if (abortAgentRequested) return
      if (call.name === 'navigate') {
        const args = call.arguments as { url?: string }
        markAgentNavigationIntent(args?.url)
      }
      const result = (await executeToolCall(call)) as ToolResultMessage
      if (call.name === 'navigate' && !result.isError) {
        markAgentNavigationResult(result.details)
      }
      chatController.addMessage(wrapMessage(result))
      scrollToBottom(true)
    }
  }
}

function startChatMessage(text: string) {
  const input = text.trim()
  if (!input || !chatEnabledValue) return

  errorController.clearAll()
  abortAgentRequested = false

  chatController.addMessage(wrapMessage({ role: 'user', content: input, timestamp: Date.now() }))

  panelState.chatStreaming = true
  chatSendBtn.disabled = true
  setActiveMetricsMode('chat')
  scrollToBottom(true)
  lastAction = 'chat'

  void (async () => {
    try {
      await runAgentLoop()
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      headerController.setStatus(`Error: ${message}`)
      errorController.showInlineError(message)
    } finally {
      finishStreamingMessage()
    }
  })()
}

function maybeSendQueuedChat() {
  if (panelState.chatStreaming || !chatEnabledValue) return
  if (chatQueue.length === 0) {
    renderChatQueue()
    return
  }
  const next = chatQueue.shift()
  renderChatQueue()
  if (next) startChatMessage(next.text)
}

function retryChat() {
  if (!chatEnabledValue || panelState.chatStreaming) return
  if (!chatController.hasUserMessages()) return

  errorController.clearAll()
  abortAgentRequested = false
  panelState.chatStreaming = true
  chatSendBtn.disabled = true
  setActiveMetricsMode('chat')
  lastAction = 'chat'
  scrollToBottom(true)

  void (async () => {
    try {
      await runAgentLoop()
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      headerController.setStatus(`Error: ${message}`)
      errorController.showInlineError(message)
    } finally {
      finishStreamingMessage()
    }
  })()
}

function retryLastAction() {
  if (lastAction === 'chat') {
    retryChat()
    return
  }
  sendSummarize({ refresh: true })
}

function sendChatMessage() {
  if (!chatEnabledValue) return
  const rawInput = chatInputEl.value
  const input = rawInput.trim()
  if (!input) return

  chatInputEl.value = ''
  chatInputEl.style.height = 'auto'

  const chatBusy = panelState.chatStreaming
  if (chatBusy || chatQueue.length > 0) {
    const queued = enqueueChatMessage(input)
    if (!queued) {
      chatInputEl.value = rawInput
      chatInputEl.style.height = `${Math.min(chatInputEl.scrollHeight, 120)}px`
    } else if (!chatBusy) {
      maybeSendQueuedChat()
    }
    return
  }

  startChatMessage(input)
}

refreshBtn.addEventListener('click', () => sendSummarize({ refresh: true }))
clearBtn.addEventListener('click', () => {
  void clearCurrentView()
})
drawerToggleBtn.addEventListener('click', () => toggleDrawer())
advancedBtn.addEventListener('click', () => {
  void send({ type: 'panel:openOptions' })
})

chatSendBtn.addEventListener('click', sendChatMessage)
chatInputEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    sendChatMessage()
  }
})
chatInputEl.addEventListener('input', () => {
  chatInputEl.style.height = 'auto'
  chatInputEl.style.height = `${Math.min(chatInputEl.scrollHeight, 120)}px`
})

const bumpFontSize = (delta: number) => {
  void (async () => {
    const nextSize = clampFontSize(currentFontSize + delta)
    const next = await patchSettings({ fontSize: nextSize })
    applyTypography(next.fontFamily, next.fontSize, next.lineHeight)
    setCurrentFontSize(next.fontSize)
    setCurrentLineHeight(next.lineHeight)
  })()
}

sizeSmBtn.addEventListener('click', () => bumpFontSize(-1))
sizeLgBtn.addEventListener('click', () => bumpFontSize(1))

const bumpLineHeight = (delta: number) => {
  void (async () => {
    const nextHeight = clampLineHeight(currentLineHeight + delta)
    const next = await patchSettings({ lineHeight: nextHeight })
    applyTypography(next.fontFamily, next.fontSize, next.lineHeight)
    setCurrentLineHeight(next.lineHeight)
  })()
}

lineTightBtn.addEventListener('click', () => bumpLineHeight(-LINE_HEIGHT_STEP))
lineLooseBtn.addEventListener('click', () => bumpLineHeight(LINE_HEIGHT_STEP))

modelPresetEl.addEventListener('change', () => {
  updateModelRowUI()
  if (!modelCustomEl.hidden) modelCustomEl.focus()
  void (async () => {
    await patchSettings({ model: readCurrentModelValue() })
  })()
})

modelCustomEl.addEventListener('change', () => {
  void (async () => {
    await patchSettings({ model: readCurrentModelValue() })
  })()
})

modelCustomEl.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter') return
  event.preventDefault()
  modelCustomEl.blur()
  void (async () => {
    await patchSettings({ model: readCurrentModelValue() })
  })()
})

slidesLayoutEl.addEventListener('change', () => {
  const next = slidesLayoutEl.value === 'gallery' ? 'gallery' : 'strip'
  setSlidesLayout(next)
  void (async () => {
    await patchSettings({ slidesLayout: next })
  })()
})

modelPresetEl.addEventListener('focus', refreshModelsIfStale)
modelPresetEl.addEventListener('pointerdown', refreshModelsIfStale)
modelCustomEl.addEventListener('focus', refreshModelsIfStale)
modelCustomEl.addEventListener('pointerdown', refreshModelsIfStale)
advancedSettingsEl.addEventListener('toggle', () => {
  if (advancedSettingsEl.open) refreshModelsIfStale()
})
modelRefreshBtn.addEventListener('click', () => {
  void runRefreshFree()
})

void (async () => {
  await ensurePanelPort()
  const s = await loadSettings()
  setCurrentFontSize(s.fontSize)
  setCurrentLineHeight(s.lineHeight)
  autoValue = s.autoSummarize
  chatEnabledValue = s.chatEnabled
  automationEnabledValue = s.automationEnabled
  slidesLayoutValue = s.slidesLayout
  slidesLayoutEl.value = slidesLayoutValue
  if (!automationEnabledValue) hideAutomationNotice()
  autoToggle.update({
    id: 'sidepanel-auto',
    label: 'Auto summarize',
    checked: autoValue,
    onCheckedChange: (checked) => {
      autoValue = checked
      void send({ type: 'panel:setAuto', value: checked })
    },
  })
  applyChatEnabled()
  applySlidesLayout()
  pickerSettings = {
    scheme: s.colorScheme,
    mode: s.colorMode,
    fontFamily: s.fontFamily,
    length: s.length,
  }
  pickers.update({
    scheme: pickerSettings.scheme,
    mode: pickerSettings.mode,
    fontFamily: pickerSettings.fontFamily,
    onSchemeChange: pickerHandlers.onSchemeChange,
    onModeChange: pickerHandlers.onModeChange,
    onFontChange: pickerHandlers.onFontChange,
  })
  lengthPicker.update({
    length: pickerSettings.length,
    onLengthChange: pickerHandlers.onLengthChange,
  })
  setDefaultModelPresets()
  setModelValue(s.model)
  setModelPlaceholderFromDiscovery({})
  updateModelRowUI()
  modelRefreshBtn.disabled = !s.token.trim()
  applyTypography(s.fontFamily, s.fontSize, s.lineHeight)
  applyTheme({ scheme: s.colorScheme, mode: s.colorMode })
  toggleDrawer(false, { animate: false })
  void send({ type: 'panel:ready' })
  scheduleAutoKick()
})()

setInterval(() => {
  void send({ type: 'panel:ping' })
}, 25_000)

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local') return
  const nextSettings = changes.settings?.newValue
  if (!nextSettings || typeof nextSettings !== 'object') return
  const nextChatEnabled = (nextSettings as { chatEnabled?: unknown }).chatEnabled
  if (typeof nextChatEnabled === 'boolean' && nextChatEnabled !== chatEnabledValue) {
    chatEnabledValue = nextChatEnabled
    applyChatEnabled()
  }
  const nextAutomationEnabled = (nextSettings as { automationEnabled?: unknown }).automationEnabled
  if (typeof nextAutomationEnabled === 'boolean') {
    automationEnabledValue = nextAutomationEnabled
    if (!automationEnabledValue) hideAutomationNotice()
  }
})

let lastVisibility = document.visibilityState
let panelMarkedOpen = document.visibilityState === 'visible'

function markPanelOpen() {
  if (panelMarkedOpen) return
  panelMarkedOpen = true
  void send({ type: 'panel:ready' })
  scheduleAutoKick()
  void syncWithActiveTab()
}

function markPanelClosed() {
  if (!panelMarkedOpen) return
  panelMarkedOpen = false
  window.clearTimeout(autoKickTimer)
  void send({ type: 'panel:closed' })
}

document.addEventListener('visibilitychange', () => {
  const visible = document.visibilityState === 'visible'
  const wasVisible = lastVisibility === 'visible'
  if (visible && !wasVisible) {
    markPanelOpen()
  } else if (!visible && wasVisible) {
    markPanelClosed()
  }
  lastVisibility = document.visibilityState
})

window.addEventListener('focus', () => {
  if (document.visibilityState !== 'visible') return
  markPanelOpen()
})

window.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter' || !event.shiftKey) return
  const target = event.target as HTMLElement | null
  if (
    target &&
    (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)
  ) {
    return
  }
  event.preventDefault()
  sendSummarize({ refresh: true })
})

window.addEventListener('beforeunload', () => {
  void send({ type: 'panel:closed' })
})
