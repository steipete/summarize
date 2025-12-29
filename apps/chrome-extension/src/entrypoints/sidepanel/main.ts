import MarkdownIt from 'markdown-it'

import { buildIdleSubtitle } from '../../lib/header'
import { buildMetricsParts, buildMetricsTokens } from '../../lib/metrics'
import { defaultSettings, loadSettings, patchSettings } from '../../lib/settings'
import { applyTheme } from '../../lib/theme'
import { generateToken } from '../../lib/token'
import { mountCheckbox } from '../../ui/zag-checkbox'
import { createHeaderController } from './header-controller'
import { mountSidepanelLengthPicker, mountSidepanelPickers } from './pickers'
import { createStreamController } from './stream-controller'
import type { ChatMessage, PanelPhase, PanelState, RunStart, UiState } from './types'

type PanelToBg =
  | { type: 'panel:ready' }
  | { type: 'panel:summarize'; refresh?: boolean }
  | { type: 'panel:startChat' }
  | { type: 'panel:chat'; messages: Array<{ role: 'user' | 'assistant'; content: string }> }
  | { type: 'panel:ping' }
  | { type: 'panel:closed' }
  | { type: 'panel:rememberUrl'; url: string }
  | { type: 'panel:setAuto'; value: boolean }
  | { type: 'panel:setLength'; value: string }
  | { type: 'panel:openOptions' }

type ChatReadyPayload = {
  url: string
  title: string | null
  transcript: string
}

type ChatStartPayload = {
  id: string
  url: string
}

type BgToPanel =
  | { type: 'ui:state'; state: UiState }
  | { type: 'ui:status'; status: string }
  | { type: 'run:start'; run: RunStart }
  | { type: 'run:error'; message: string }
  | { type: 'chat:ready'; payload: ChatReadyPayload }
  | { type: 'chat:start'; payload: ChatStartPayload }

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
const renderEl = byId<HTMLElement>('render')
const metricsEl = byId<HTMLDivElement>('metrics')
const metricsHomeEl = byId<HTMLDivElement>('metricsHome')
const chatMetricsSlotEl = byId<HTMLDivElement>('chatMetricsSlot')

const summarizeBtn = byId<HTMLButtonElement>('summarize')
const chatBtn = byId<HTMLButtonElement>('chat')
const drawerToggleBtn = byId<HTMLButtonElement>('drawerToggle')
const refreshBtn = byId<HTMLButtonElement>('refresh')
const advancedBtn = byId<HTMLButtonElement>('advanced')
const autoToggleRoot = byId<HTMLDivElement>('autoToggle')
const hoverToggleRoot = byId<HTMLDivElement>('hoverToggle')
const lengthRoot = byId<HTMLDivElement>('lengthRoot')
const pickersRoot = byId<HTMLDivElement>('pickersRoot')
const sizeEl = byId<HTMLInputElement>('size')

// Chat elements
const chatContainerEl = byId<HTMLElement>('chatContainer')
const chatMessagesEl = byId<HTMLDivElement>('chatMessages')
const chatInputEl = byId<HTMLTextAreaElement>('chatInput')
const chatSendBtn = byId<HTMLButtonElement>('chatSend')
const chatBackBtn = byId<HTMLButtonElement>('chatBack')

const md = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: false,
})

const panelState: PanelState = {
  ui: null,
  currentSource: null,
  lastMeta: { inputSummary: null, model: null, modelLabel: null },
  summaryFromCache: null,
  phase: 'idle',
  error: null,
  // Chat state
  inChatMode: false,
  chatMessages: [],
  chatStreaming: false,
  chatTranscript: null,
}
let drawerAnimation: Animation | null = null
let autoValue = false
let hoverSummariesValue = defaultSettings.hoverSummaries

const isStreaming = () => panelState.phase === 'connecting' || panelState.phase === 'streaming'

const setPhase = (phase: PanelPhase, opts?: { error?: string | null }) => {
  panelState.phase = phase
  panelState.error = phase === 'error' ? (opts?.error ?? panelState.error) : null
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
      panelState.currentSource = null
      setPhase('idle')
      resetSummaryView()
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

function resetSummaryView() {
  renderEl.innerHTML = ''
  clearMetricsForMode('summary')
  panelState.summaryFromCache = null

  // Also reset chat state if in chat mode
  if (panelState.inChatMode) {
    exitChatMode()
  }
  resetChatState()
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
  try {
    renderEl.innerHTML = md.render(markdown)
  } catch (err) {
    const message = err instanceof Error ? err.stack || err.message : String(err)
    headerController.setStatus(`Error: ${message}`)
    return
  }
  for (const a of Array.from(renderEl.querySelectorAll('a'))) {
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

function applyTypography(fontFamily: string, fontSize: number) {
  document.documentElement.style.setProperty('--font-body', fontFamily)
  document.documentElement.style.setProperty('--font-size', `${fontSize}px`)
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
      applyTypography(next.fontFamily, next.fontSize)
    })()
  },
  onLengthChange: (value) => {
    pickerSettings = { ...pickerSettings, length: value }
    send({ type: 'panel:setLength', value })
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
    send({ type: 'panel:setAuto', value: checked })
  },
})

const hoverToggle = mountCheckbox(hoverToggleRoot, {
  id: 'sidepanel-hover',
  label: 'Hover summaries',
  checked: hoverSummariesValue,
  onCheckedChange: (checked) => {
    hoverSummariesValue = checked
    void patchSettings({ hoverSummaries: checked })
    hoverToggle.update({
      id: 'sidepanel-hover',
      label: 'Hover summaries',
      checked: hoverSummariesValue,
      onCheckedChange: (nextChecked) => {
        hoverSummariesValue = nextChecked
        void patchSettings({ hoverSummaries: nextChecked })
      },
    })
  },
})

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

const streamController = createStreamController({
  getToken: async () => (await loadSettings()).token,
  onReset: () => {
    renderEl.innerHTML = ''
    clearMetricsForMode('summary')
    panelState.summaryFromCache = null
    panelState.lastMeta = { inputSummary: null, model: null, modelLabel: null }
  },
  onStatus: (text) => headerController.setStatus(text),
  onBaseTitle: (text) => headerController.setBaseTitle(text),
  onBaseSubtitle: (text) => headerController.setBaseSubtitle(text),
  onPhaseChange: (phase) => {
    setPhase(phase)
  },
  onRememberUrl: (url) => send({ type: 'panel:rememberUrl', url }),
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
  },
  onRender: renderMarkdown,
  onSyncWithActiveTab: syncWithActiveTab,
  onError: (err) => friendlyFetchError(err, 'Stream failed'),
})

// Chat stream controller - reuses the same SSE infrastructure as summarize
const chatStreamController = createStreamController({
  mode: 'chat',
  getToken: async () => (await loadSettings()).token,
  onReset: () => {
    clearMetricsForMode('chat')
  },
  onStatus: (text) => headerController.setStatus(text),
  onPhaseChange: (phase) => {
    // Chat doesn't use phase in the same way, but we track streaming state
    if (phase === 'error') {
      finishStreamingMessage()
    }
  },
  onMeta: () => {},
  onMetrics: (summary) => {
    setMetricsForMode('chat', summary, null, panelState.currentSource?.url ?? null)
  },
  onChunk: (content) => {
    updateStreamingMessage(content)
  },
  onDone: () => {
    finishStreamingMessage()
  },
  onError: (err) => {
    const message = err instanceof Error ? err.message : String(err)
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

  const installIntro = isMac
    ? `
      <p><strong>1) Install summarize (choose one)</strong></p>
      <code>${npmCmd}</code>
      <code>${brewCmd}</code>
      <p class="setup__hint">Homebrew installs the daemon-ready binary (macOS arm64).</p>
    `
    : `
      <p><strong>1) Install summarize</strong></p>
      <code>${npmCmd}</code>
      <p class="setup__hint">Homebrew tap is macOS-only.</p>
    `

  const daemonIntro = isSupported
    ? `
      <p><strong>2) Register the daemon (${daemonLabel})</strong></p>
      <code>${daemonCmd}</code>
    `
    : `
      <p><strong>2) Daemon auto-start</strong></p>
      <p class="setup__hint">Not supported on this OS yet.</p>
    `

  const copyRow = isMac
    ? `
      <div class="row">
        <button id="copy-npm" type="button">Copy npm</button>
        <button id="copy-brew" type="button">Copy brew</button>
      </div>
      <div class="row">
        <button id="copy-daemon" type="button">Copy daemon</button>
        <button id="regen" type="button">Regenerate Token</button>
      </div>
    `
    : isSupported
      ? `
      <div class="row">
        <button id="copy-npm" type="button">Copy npm</button>
        <button id="copy-daemon" type="button">Copy daemon</button>
      </div>
      <div class="row">
        <button id="regen" type="button">Regenerate Token</button>
      </div>
    `
      : `
      <div class="row">
        <button id="copy-npm" type="button">Copy npm</button>
        <button id="regen" type="button">Regenerate Token</button>
      </div>
    `

  const troubleshooting =
    showTroubleshooting && isSupported
      ? `
      <div class="row">
        <button id="status" type="button">Copy Status Command</button>
        <button id="restart" type="button">Copy Restart Command</button>
      </div>
    `
      : ''

  return `
    <h2>${headline}</h2>
    ${message ? `<p>${message}</p>` : ''}
    ${installIntro}
    ${daemonIntro}
    ${copyRow}
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

  const flashCopied = () => {
    headerController.setStatus('Copied')
    setTimeout(() => headerController.setStatus(panelState.ui?.status ?? ''), 800)
  }

  setupEl.querySelector<HTMLButtonElement>('#copy-npm')?.addEventListener('click', () => {
    void (async () => {
      await navigator.clipboard.writeText(npmCmd)
      flashCopied()
    })()
  })

  setupEl.querySelector<HTMLButtonElement>('#copy-brew')?.addEventListener('click', () => {
    void (async () => {
      await navigator.clipboard.writeText(brewCmd)
      flashCopied()
    })()
  })

  setupEl.querySelector<HTMLButtonElement>('#copy-daemon')?.addEventListener('click', () => {
    void (async () => {
      await navigator.clipboard.writeText(daemonCmd)
      flashCopied()
    })()
  })

  setupEl.querySelector<HTMLButtonElement>('#regen')?.addEventListener('click', () => {
    void (async () => {
      const token2 = generateToken()
      await patchSettings({ token: token2 })
      renderSetup(token2)
    })()
  })

  if (!showTroubleshooting) return

  setupEl.querySelector<HTMLButtonElement>('#status')?.addEventListener('click', () => {
    void (async () => {
      await navigator.clipboard.writeText('summarize daemon status')
      flashCopied()
    })()
  })

  setupEl.querySelector<HTMLButtonElement>('#restart')?.addEventListener('click', () => {
    void (async () => {
      await navigator.clipboard.writeText('summarize daemon restart')
      flashCopied()
    })()
  })
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
  autoValue = state.settings.autoSummarize
  autoToggle.update({
    id: 'sidepanel-auto',
    label: 'Auto summarize',
    checked: autoValue,
    onCheckedChange: (checked) => {
      autoValue = checked
      send({ type: 'panel:setAuto', value: checked })
    },
  })
  if (pickerSettings.length !== state.settings.length) {
    pickerSettings = { ...pickerSettings, length: state.settings.length }
    lengthPicker.update({
      length: pickerSettings.length,
      onLengthChange: pickerHandlers.onLengthChange,
    })
  }
  if (panelState.currentSource) {
    if (state.tab.url && !urlsMatch(state.tab.url, panelState.currentSource.url)) {
      panelState.currentSource = null
      streamController.abort()
      resetSummaryView()
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
      if (panelState.inChatMode) {
        exitChatMode()
      }
      panelState.currentSource = { url: msg.run.url, title: msg.run.title }
      panelState.lastMeta = { inputSummary: null, model: null, modelLabel: null }
      void streamController.start(msg.run)
      return
    case 'chat:ready':
      panelState.currentSource = { url: msg.payload.url, title: msg.payload.title }
      panelState.chatTranscript = msg.payload.transcript
      enterChatMode()
      return
    case 'chat:start':
      void chatStreamController.start({
        id: msg.payload.id,
        url: msg.payload.url,
        title: panelState.currentSource?.title || null,
        reason: 'chat',
      })
      return
  }
}

function send(message: PanelToBg) {
  void chrome.runtime.sendMessage(message).catch(() => {
    // ignore (panel/background race while reloading)
  })
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

// Chat functions
function enterChatMode() {
  panelState.inChatMode = true
  panelState.chatMessages = []
  panelState.chatStreaming = false
  chatMessagesEl.innerHTML = ''
  chatInputEl.value = ''
  chatSendBtn.disabled = false

  // Hide summarize view, show chat view
  renderEl.classList.add('hidden')
  setupEl.classList.add('hidden')
  chatContainerEl.classList.remove('hidden')
  clearMetricsForMode('chat')
  setActiveMetricsMode('chat')

  // Update header
  headerController.setBaseTitle('Chat')
  headerController.setBaseSubtitle(panelState.currentSource?.title || '')
  headerController.setStatus('')
}

function exitChatMode() {
  panelState.inChatMode = false
  panelState.chatMessages = []
  panelState.chatStreaming = false
  panelState.chatTranscript = null

  // Show summarize view, hide chat view
  chatContainerEl.classList.add('hidden')
  renderEl.classList.remove('hidden')
  setActiveMetricsMode('summary')

  // Restore header
  headerController.setBaseTitle(panelState.currentSource?.title || 'Summarize')
  headerController.setBaseSubtitle(
    buildIdleSubtitle({
      inputSummary: panelState.lastMeta.inputSummary,
      modelLabel: panelState.lastMeta.modelLabel,
      model: panelState.lastMeta.model,
    })
  )
  headerController.setStatus('')
}

function resetChatState() {
  panelState.chatMessages = []
  panelState.chatStreaming = false
  panelState.chatTranscript = null
  chatMessagesEl.innerHTML = ''
  chatInputEl.value = ''
  chatSendBtn.disabled = false
}

function addChatMessage(message: ChatMessage) {
  panelState.chatMessages.push(message)
  renderChatMessage(message)
}

function renderChatMessage(message: ChatMessage) {
  const msgEl = document.createElement('div')
  msgEl.className = `chatMessage ${message.role}`
  msgEl.dataset.id = message.id

  if (message.role === 'assistant') {
    msgEl.innerHTML = md.render(message.content || '...')
    // Open links in new tabs
    for (const a of Array.from(msgEl.querySelectorAll('a'))) {
      a.setAttribute('target', '_blank')
      a.setAttribute('rel', 'noopener noreferrer')
    }
  } else {
    msgEl.textContent = message.content
  }

  chatMessagesEl.appendChild(msgEl)
  chatMessagesEl.scrollTop = chatMessagesEl.scrollHeight
}

function updateStreamingMessage(content: string) {
  const lastMsg = panelState.chatMessages[panelState.chatMessages.length - 1]
  if (lastMsg?.role === 'assistant') {
    lastMsg.content = content
    const msgEl = chatMessagesEl.querySelector(`[data-id="${lastMsg.id}"]`)
    if (msgEl) {
      msgEl.innerHTML = md.render(content || '...')
      msgEl.classList.add('streaming')
      // Open links in new tabs
      for (const a of Array.from(msgEl.querySelectorAll('a'))) {
        a.setAttribute('target', '_blank')
        a.setAttribute('rel', 'noopener noreferrer')
      }
      chatMessagesEl.scrollTop = chatMessagesEl.scrollHeight
    }
  }
}

function finishStreamingMessage() {
  panelState.chatStreaming = false
  chatSendBtn.disabled = false
  chatInputEl.focus()

  const lastMsg = panelState.chatMessages[panelState.chatMessages.length - 1]
  if (lastMsg?.role === 'assistant') {
    const msgEl = chatMessagesEl.querySelector(`[data-id="${lastMsg.id}"]`)
    if (msgEl) {
      msgEl.classList.remove('streaming')
    }
  }
}

function sendChatMessage() {
  const input = chatInputEl.value.trim()
  if (!input || panelState.chatStreaming) return

  chatInputEl.value = ''
  chatInputEl.style.height = 'auto'

  // Add user message
  addChatMessage({
    id: crypto.randomUUID(),
    role: 'user',
    content: input,
    timestamp: Date.now(),
  })

  // Add placeholder for assistant
  addChatMessage({
    id: crypto.randomUUID(),
    role: 'assistant',
    content: '',
    timestamp: Date.now(),
  })

  panelState.chatStreaming = true
  chatSendBtn.disabled = true

  // Send to background
  send({
    type: 'panel:chat',
    messages: panelState.chatMessages
      .filter((m) => m.content.length > 0)
      .map((m) => ({ role: m.role, content: m.content })),
  })
}

summarizeBtn.addEventListener('click', () => send({ type: 'panel:summarize' }))
chatBtn.addEventListener('click', () => send({ type: 'panel:startChat' }))
refreshBtn.addEventListener('click', () => send({ type: 'panel:summarize', refresh: true }))
drawerToggleBtn.addEventListener('click', () => toggleDrawer())
advancedBtn.addEventListener('click', () => send({ type: 'panel:openOptions' }))

// Chat event handlers
chatBackBtn.addEventListener('click', exitChatMode)
chatSendBtn.addEventListener('click', sendChatMessage)
chatInputEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    sendChatMessage()
  }
})
chatInputEl.addEventListener('input', () => {
  chatInputEl.style.height = 'auto'
  chatInputEl.style.height = Math.min(chatInputEl.scrollHeight, 120) + 'px'
})

sizeEl.addEventListener('input', () => {
  void (async () => {
    const next = await patchSettings({ fontSize: Number(sizeEl.value) })
    applyTypography(next.fontFamily, next.fontSize)
  })()
})

void (async () => {
  const s = await loadSettings()
  sizeEl.value = String(s.fontSize)
  autoValue = s.autoSummarize
  hoverSummariesValue = s.hoverSummaries
  autoToggle.update({
    id: 'sidepanel-auto',
    label: 'Auto summarize',
    checked: autoValue,
    onCheckedChange: (checked) => {
      autoValue = checked
      send({ type: 'panel:setAuto', value: checked })
    },
  })
  hoverToggle.update({
    id: 'sidepanel-hover',
    label: 'Hover summaries',
    checked: hoverSummariesValue,
    onCheckedChange: (checked) => {
      hoverSummariesValue = checked
      void patchSettings({ hoverSummaries: checked })
    },
  })
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
  applyTypography(s.fontFamily, s.fontSize)
  applyTheme({ scheme: s.colorScheme, mode: s.colorMode })
  toggleDrawer(false, { animate: false })
  chrome.runtime.onMessage.addListener((msg: BgToPanel) => {
    handleBgMessage(msg)
  })
  send({ type: 'panel:ready' })
})()

setInterval(() => {
  send({ type: 'panel:ping' })
}, 25_000)

let lastVisibility = document.visibilityState
document.addEventListener('visibilitychange', () => {
  const visible = document.visibilityState === 'visible'
  const wasVisible = lastVisibility === 'visible'
  if (visible && !wasVisible) {
    send({ type: 'panel:ready' })
    void syncWithActiveTab()
  } else if (!visible && wasVisible) {
    send({ type: 'panel:closed' })
  }
  lastVisibility = document.visibilityState
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
  send({ type: 'panel:summarize', refresh: true })
})

window.addEventListener('beforeunload', () => {
  send({ type: 'panel:closed' })
})
