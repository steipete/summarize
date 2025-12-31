import type { AssistantMessage, Message, ToolCall, ToolResultMessage } from '@mariozechner/pi-ai'
import MarkdownIt from 'markdown-it'

import { parseSseEvent } from '../../../../../src/shared/sse-events.js'
import { listSkills } from '../../automation/skills-store'
import { executeToolCall, getAutomationToolNames } from '../../automation/tools'
import { readPresetOrCustomValue } from '../../lib/combo'
import { buildIdleSubtitle } from '../../lib/header'
import { buildMetricsParts, buildMetricsTokens } from '../../lib/metrics'
import { defaultSettings, loadSettings, patchSettings } from '../../lib/settings'
import { parseSseStream } from '../../lib/sse'
import { applyTheme } from '../../lib/theme'
import { generateToken } from '../../lib/token'
import { mountCheckbox } from '../../ui/zag-checkbox'
import { ChatController } from './chat-controller'
import { type ChatHistoryLimits, compactChatHistory } from './chat-state'
import { createHeaderController } from './header-controller'
import { mountSidepanelLengthPicker, mountSidepanelPickers, mountSummarizeControl } from './pickers'
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
  | { type: 'panel:seek'; seconds: number }
  | { type: 'panel:ping' }
  | { type: 'panel:closed' }
  | { type: 'panel:rememberUrl'; url: string }
  | { type: 'panel:setAuto'; value: boolean }
  | { type: 'panel:setLength'; value: string }
  | { type: 'panel:openOptions' }

type BgToPanel =
  | { type: 'ui:state'; state: UiState }
  | { type: 'ui:status'; status: string }
  | { type: 'run:start'; run: RunStart }
  | { type: 'run:error'; message: string }
  | {
      type: 'agent:response'
      requestId: string
      ok: boolean
      assistant?: AssistantMessage
      error?: string
    }

let panelPort: chrome.runtime.Port | null = null
let panelPortConnecting: Promise<chrome.runtime.Port | null> | null = null
let panelWindowId: number | null = null

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
const renderEl = byId<HTMLElement>('render')
const mainEl = document.querySelector('main') as HTMLElement
if (!mainEl) throw new Error('Missing <main>')
const metricsEl = byId<HTMLDivElement>('metrics')
const metricsHomeEl = byId<HTMLDivElement>('metricsHome')
const chatMetricsSlotEl = byId<HTMLDivElement>('chatMetricsSlot')
const chatDockEl = byId<HTMLDivElement>('chatDock')

const summarizeControlRoot = byId<HTMLElement>('summarizeControlRoot')
const drawerToggleBtn = byId<HTMLButtonElement>('drawerToggle')
const refreshBtn = byId<HTMLButtonElement>('refresh')
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

const chatContainerEl = byId<HTMLElement>('chatContainer')
const chatMessagesEl = byId<HTMLDivElement>('chatMessages')
const chatInputEl = byId<HTMLTextAreaElement>('chatInput')
const chatSendBtn = byId<HTMLButtonElement>('chatSend')
const chatContextStatusEl = byId<HTMLDivElement>('chatContextStatus')
const chatJumpBtn = byId<HTMLButtonElement>('chatJump')
const chatQueueEl = byId<HTMLDivElement>('chatQueue')

const md = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: false,
})

const panelState: PanelState = {
  ui: null,
  currentSource: null,
  lastMeta: { inputSummary: null, model: null, modelLabel: null },
  summaryMarkdown: null,
  summaryFromCache: null,
  phase: 'idle',
  error: null,
  chatStreaming: false,
}
let drawerAnimation: Animation | null = null
let autoValue = false
let chatEnabledValue = defaultSettings.chatEnabled
let automationEnabledValue = defaultSettings.automationEnabled
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
  onNewContent: () => updateAutoScrollLock(),
})

type AgentResponse = { ok: boolean; assistant?: AssistantMessage; error?: string }
const pendingAgentRequests = new Map<
  string,
  { resolve: (response: AgentResponse) => void; reject: (error: Error) => void }
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

function handleAgentResponse(msg: Extract<BgToPanel, { type: 'agent:response' }>) {
  const pending = pendingAgentRequests.get(msg.requestId)
  if (!pending) return
  pendingAgentRequests.delete(msg.requestId)
  pending.resolve({ ok: msg.ok, assistant: msg.assistant, error: msg.error })
}

async function requestAgent(messages: Message[], tools: string[], summary?: string | null) {
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
    })
    void send({ type: 'panel:agent', requestId, messages, tools, summary })
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

const summarizeControl = mountSummarizeControl(summarizeControlRoot, {
  value: inputMode,
  mediaAvailable: false,
  videoLabel: 'Video',
  onValueChange: (value) => {
    inputMode = value
  },
  onSummarize: () => sendSummarize(),
})

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

const showError = (message: string) => {
  errorMessageEl.textContent = message
  errorEl.classList.remove('hidden')
}

const clearError = () => {
  errorMessageEl.textContent = ''
  errorEl.classList.add('hidden')
}

const setPhase = (phase: PanelPhase, opts?: { error?: string | null }) => {
  panelState.phase = phase
  panelState.error = phase === 'error' ? (opts?.error ?? panelState.error) : null
  if (phase === 'error') {
    showError(panelState.error ?? 'Something went wrong.')
  } else {
    clearError()
  }
  if (phase !== 'connecting' && phase !== 'streaming') {
    headerController.stopProgress()
  }
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
  if (
    pending &&
    Date.now() - pending.at < AGENT_NAV_TTL_MS &&
    urlsMatch(url, pending.url)
  ) {
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

function resetSummaryView({ preserveChat = false }: { preserveChat?: boolean } = {}) {
  renderEl.innerHTML = ''
  clearMetricsForMode('summary')
  panelState.summaryMarkdown = null
  panelState.summaryFromCache = null
  if (!preserveChat) {
    resetChatState()
  }
}

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

function renderMarkdown(markdown: string) {
  panelState.summaryMarkdown = markdown
  try {
    renderEl.innerHTML = md.render(linkifyTimestamps(markdown))
  } catch (err) {
    const message = err instanceof Error ? err.stack || err.message : String(err)
    headerController.setStatus(`Error: ${message}`)
    return
  }
  for (const a of Array.from(renderEl.querySelectorAll('a'))) {
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
  if (loadId !== chatHistoryLoadId || !history?.length) return
  const compacted = compactChatHistory(history, chatLimits)
  chatController.setMessages(compacted, { scroll: false })
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

const streamController = createStreamController({
  getToken: async () => (await loadSettings()).token,
  onReset: () => {
    const preserveChat = preserveChatOnNextReset
    preserveChatOnNextReset = false
    resetSummaryView({ preserveChat })
    panelState.lastMeta = { inputSummary: null, model: null, modelLabel: null }
    lastStreamError = null
  },
  onStatus: (text) => headerController.setStatus(text),
  onBaseTitle: (text) => headerController.setBaseTitle(text),
  onBaseSubtitle: (text) => headerController.setBaseSubtitle(text),
  onPhaseChange: (phase) => {
    if (phase === 'error') {
      setPhase('error', { error: lastStreamError ?? panelState.error })
    } else {
      setPhase(phase)
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
  },
  onSummaryFromCache: (value) => {
    panelState.summaryFromCache = value
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
  const tabChanged = nextTabId !== activeTabId
  const urlChanged =
    !tabChanged && nextTabUrl && activeTabUrl && !urlsMatch(nextTabUrl, activeTabUrl)
  const nextMediaAvailable = Boolean(state.media && (state.media.hasVideo || state.media.hasAudio))
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
    inputMode = 'page'
    inputModeOverride = null
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
  if (!isStreaming() || state.status.trim().length > 0) {
    headerController.setStatus(state.status)
  }
  if (!nextMediaAvailable) {
    inputMode = 'page'
    inputModeOverride = null
  }
  mediaAvailable = nextMediaAvailable
  summarizeControl.update({
    value: inputMode,
    mediaAvailable,
    videoLabel: nextVideoLabel,
    pageWords: state.stats.pageWords,
    videoDurationSeconds: state.stats.videoDurationSeconds,
    onValueChange: (value) => {
      inputMode = value
      inputModeOverride = value
      if (autoValue) {
        sendSummarize({ refresh: true })
      }
    },
    onSummarize: () => sendSummarize(),
  })
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
      if (!isStreaming() || msg.status.trim().length > 0) {
        headerController.setStatus(msg.status)
      }
      return
    case 'run:error':
      headerController.setStatus(`Error: ${msg.message}`)
      setPhase('error', { error: msg.message })
      if (panelState.chatStreaming) {
        finishStreamingMessage()
      }
      return
    case 'run:start':
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
      panelState.currentSource = { url: msg.run.url, title: msg.run.title }
      panelState.lastMeta = { inputSummary: null, model: null, modelLabel: null }
      void streamController.start(msg.run)
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
    let response: AgentResponse
    try {
      response = await requestAgent(messages, tools, panelState.summaryMarkdown)
    } catch (error) {
      if (abortAgentRequested) return
      throw error
    }
    if (!response.ok || !response.assistant) {
      throw new Error(response.error || 'Agent failed')
    }

    const assistant = response.assistant
    if (abortAgentRequested) return
    chatController.addMessage(wrapMessage(assistant))
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

  clearError()
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
      setPhase('error', { error: message })
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

  clearError()
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
      setPhase('error', { error: message })
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
errorRetryBtn.addEventListener('click', () => retryLastAction())
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
