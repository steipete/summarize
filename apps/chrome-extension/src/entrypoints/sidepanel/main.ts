import MarkdownIt from 'markdown-it'

import { buildIdleSubtitle } from '../../lib/header'
import { defaultSettings, loadSettings, patchSettings } from '../../lib/settings'
import { parseSseStream } from '../../lib/sse'
import { splitStatusPercent } from '../../lib/status'
import { applyTheme } from '../../lib/theme'
import { generateToken } from '../../lib/token'
import { mountCheckbox } from '../../ui/zag-checkbox'
import { mountSidepanelLengthPicker, mountSidepanelPickers } from './pickers'

type PanelToBg =
  | { type: 'panel:ready' }
  | { type: 'panel:summarize'; refresh?: boolean }
  | { type: 'panel:ping' }
  | { type: 'panel:closed' }
  | { type: 'panel:rememberUrl'; url: string }
  | { type: 'panel:setAuto'; value: boolean }
  | { type: 'panel:setLength'; value: string }
  | { type: 'panel:openOptions' }

type UiState = {
  panelOpen: boolean
  daemon: { ok: boolean; authed: boolean; error?: string }
  tab: { url: string | null; title: string | null }
  settings: { autoSummarize: boolean; model: string; length: string; tokenPresent: boolean }
  status: string
}

type RunStart = {
  id: string
  url: string
  title: string | null
  model: string
  reason: string
}

type BgToPanel =
  | { type: 'ui:state'; state: UiState }
  | { type: 'ui:status'; status: string }
  | { type: 'run:start'; run: RunStart }
  | { type: 'run:error'; message: string }

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

const summarizeBtn = byId<HTMLButtonElement>('summarize')
const drawerToggleBtn = byId<HTMLButtonElement>('drawerToggle')
const refreshBtn = byId<HTMLButtonElement>('refresh')
const advancedBtn = byId<HTMLButtonElement>('advanced')
const autoToggleRoot = byId<HTMLDivElement>('autoToggle')
const lengthRoot = byId<HTMLDivElement>('lengthRoot')
const pickersRoot = byId<HTMLDivElement>('pickersRoot')
const sizeEl = byId<HTMLInputElement>('size')

const md = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: false,
})

function updateHeaderOffset() {
  const height = headerEl.getBoundingClientRect().height
  document.documentElement.style.setProperty('--header-height', `${height}px`)
}

updateHeaderOffset()
window.addEventListener('resize', updateHeaderOffset)

let markdown = ''
let renderQueued = 0
let currentState: UiState | null = null
let currentSource: { url: string; title: string | null } | null = null
let streamController: AbortController | null = null
let streamedAnyNonWhitespace = false
let rememberedUrl = false
let streaming = false
let showProgress = false
let summaryFromCache: boolean | null = null
let baseTitle = 'Summarize'
let baseSubtitle = ''
let statusText = ''
let lastMeta: { inputSummary: string | null; model: string | null; modelLabel: string | null } = {
  inputSummary: null,
  model: null,
  modelLabel: null,
}
let drawerAnimation: Animation | null = null
let autoValue = false

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
  if (!currentSource) return
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
    if (!tab?.url || !canSyncTabUrl(tab.url)) return
    if (!urlsMatch(tab.url, currentSource.url)) {
      currentSource = null
      resetSummaryView()
      setBaseTitle(tab.title || tab.url || 'Summarize')
      setBaseSubtitle('')
      return
    }
    if (tab.title && tab.title !== currentSource.title) {
      currentSource = { ...currentSource, title: tab.title }
      setBaseTitle(tab.title)
    }
  } catch {
    // ignore
  }
}

function resetSummaryView() {
  markdown = ''
  renderEl.innerHTML = ''
  metricsEl.textContent = ''
  metricsEl.classList.add('hidden')
  metricsEl.removeAttribute('data-details')
  metricsEl.removeAttribute('title')
  summaryFromCache = null
  streamedAnyNonWhitespace = false
  rememberedUrl = false
}

function setBaseSubtitle(text: string) {
  baseSubtitle = text
  updateHeader()
}

function setBaseTitle(text: string) {
  const next = text.trim() || 'Summarize'
  baseTitle = next
  updateHeader()
}

function setStatus(text: string) {
  statusText = text
  const trimmed = text.trim()
  const isError =
    trimmed.length > 0 &&
    (trimmed.toLowerCase().startsWith('error:') || trimmed.toLowerCase().includes(' error'))
  const split = splitStatusPercent(text)
  if (split.percent && summaryFromCache !== true) {
    armProgress()
  } else if (trimmed && summaryFromCache !== true && !isError) {
    armProgress()
  } else if (!trimmed && !streaming) {
    stopProgress()
  }
  updateHeader()
}

function updateHeader() {
  const trimmed = statusText.trim()
  const showStatus = trimmed.length > 0
  const split = showStatus
    ? splitStatusPercent(trimmed)
    : { text: '', percent: null as string | null }
  const percentNum = split.percent ? Number.parseInt(split.percent, 10) : null
  const isError =
    showStatus &&
    (trimmed.toLowerCase().startsWith('error:') || trimmed.toLowerCase().includes(' error'))
  const isRunning = showProgress && !isError
  const shouldShowStatus = showStatus && (!streaming || !baseSubtitle)

  titleEl.textContent = baseTitle
  headerEl.classList.toggle('isError', isError)
  headerEl.classList.toggle('isRunning', isRunning)
  headerEl.classList.toggle('isIndeterminate', isRunning && percentNum == null)

  if (
    !isError &&
    percentNum != null &&
    Number.isFinite(percentNum) &&
    percentNum >= 0 &&
    percentNum <= 100
  ) {
    headerEl.style.setProperty('--progress', `${percentNum}%`)
  } else {
    headerEl.style.setProperty('--progress', '0%')
  }

  progressFillEl.style.display = isRunning || isError ? '' : 'none'
  subtitleEl.textContent = isError
    ? split.text || trimmed
    : shouldShowStatus
      ? split.text || trimmed
      : baseSubtitle
}

function armProgress() {
  if (summaryFromCache === true) return
  if (showProgress) return
  showProgress = true
  updateHeader()
}

function stopProgress() {
  if (!showProgress) return
  showProgress = false
  updateHeader()
}

window.addEventListener('error', (event) => {
  const message =
    event.error instanceof Error ? event.error.stack || event.error.message : event.message
  setStatus(`Error: ${message}`)
})

window.addEventListener('unhandledrejection', (event) => {
  const reason = (event as PromiseRejectionEvent).reason
  const message = reason instanceof Error ? reason.stack || reason.message : String(reason)
  setStatus(`Error: ${message}`)
})

function queueRender() {
  if (renderQueued) return
  renderQueued = window.setTimeout(() => {
    renderQueued = 0
    try {
      renderEl.innerHTML = md.render(markdown)
    } catch (err) {
      const message = err instanceof Error ? err.stack || err.message : String(err)
      setStatus(`Error: ${message}`)
      return
    }
    for (const a of Array.from(renderEl.querySelectorAll('a'))) {
      a.setAttribute('target', '_blank')
      a.setAttribute('rel', 'noopener noreferrer')
    }
  }, 80)
}

const isHttpUrl = (value: string) => /^https?:\/\//i.test(value)
const isLikelyDomain = (value: string) =>
  /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(value) && !value.includes('..')

function renderMetricsSummary(summary: string) {
  metricsEl.replaceChildren()

  const inputSummary = lastMeta.inputSummary?.trim() ?? ''
  const inputParts = inputSummary
    ? inputSummary
        .split(' · ')
        .map((part) => part.trim())
        .filter(Boolean)
    : []
  const inputHasWords = inputParts.some((part) => /\bwords\b/i.test(part))
  const inputHasMediaDuration = inputParts.some((part) => {
    if (!/\b(YouTube|podcast|video)\b/i.test(part)) return false
    return /\bmin\b/i.test(part) || /\b\d+m\b/i.test(part) || /\b\d+s\b/i.test(part)
  })
  const normalize = (value: string) => value.replaceAll(/\s+/g, ' ').trim().toLowerCase()
  const inputPartsNormalized = new Set(inputParts.map(normalize))

  const shouldOmitPart = (raw: string) => {
    const trimmed = raw.trim()
    if (!trimmed) return true
    if (inputPartsNormalized.has(normalize(trimmed))) return true
    if (inputHasWords && /\bwords\b/i.test(trimmed)) return true
    if (
      inputHasMediaDuration &&
      /\b(YouTube|podcast|video)\b/i.test(trimmed) &&
      (/\bmin\b/i.test(trimmed) || /\b\d+m\b/i.test(trimmed) || /\b\d+s\b/i.test(trimmed))
    ) {
      return true
    }
    return false
  }

  const parts = summary.split(' · ').filter((part) => !shouldOmitPart(part))

  parts.forEach((part, index) => {
    if (index) metricsEl.append(document.createTextNode(' · '))
    const trimmed = part.trim()
    if (!trimmed) return
    if (isHttpUrl(trimmed) || isLikelyDomain(trimmed)) {
      const link = document.createElement('a')
      link.href = isHttpUrl(trimmed) ? trimmed : `https://${trimmed}`
      link.textContent = trimmed
      link.target = '_blank'
      link.rel = 'noopener noreferrer'
      metricsEl.append(link)
      return
    }
    const sourceUrl = currentSource?.url ?? null
    if (sourceUrl && isHttpUrl(sourceUrl)) {
      const sourceMatch = part.match(/\b(YouTube|podcast|video)\b/i)
      if (sourceMatch?.index != null) {
        const before = part.slice(0, sourceMatch.index)
        const label = sourceMatch[0]
        const after = part.slice(sourceMatch.index + label.length)
        if (before) metricsEl.append(document.createTextNode(before))
        const link = document.createElement('a')
        link.href = sourceUrl
        link.textContent = label
        link.target = '_blank'
        link.rel = 'noopener noreferrer'
        metricsEl.append(link)
        if (after) metricsEl.append(document.createTextNode(after))
        return
      }
    }
    metricsEl.append(document.createTextNode(part))
  })
}

function mergeStreamText(current: string, incoming: string): string {
  if (!incoming) return current
  if (!current) return incoming

  // Some providers stream cumulative buffers; prefer replacement if the incoming chunk contains everything so far.
  if (incoming.length >= current.length && incoming.startsWith(current)) {
    return incoming
  }

  // Overlap-merge to avoid duplicated tails/heads.
  const maxOverlap = Math.min(current.length, incoming.length, 2000)
  for (let overlap = maxOverlap; overlap >= 8; overlap -= 1) {
    if (current.endsWith(incoming.slice(0, overlap))) {
      return current + incoming.slice(overlap)
    }
  }

  return current + incoming
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
    setStatus('Copied')
    setTimeout(() => setStatus(currentState?.status ?? ''), 800)
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

function maybeShowSetup(state: UiState) {
  if (!state.settings.tokenPresent) {
    void (async () => {
      const token = await ensureToken()
      renderSetup(token)
    })()
    return
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
    return
  }
  setupEl.classList.add('hidden')
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
  if (currentSource) {
    if (state.tab.url && !urlsMatch(state.tab.url, currentSource.url)) {
      currentSource = null
      if (streamController) {
        streamController.abort()
        streamController = null
      }
      streaming = false
      stopProgress()
      resetSummaryView()
    } else if (state.tab.title && state.tab.title !== currentSource.title) {
      currentSource = { ...currentSource, title: state.tab.title }
      setBaseTitle(state.tab.title)
    }
  }
  if (!currentSource) {
    lastMeta = { inputSummary: null, model: null, modelLabel: null }
    setBaseTitle(state.tab.title || state.tab.url || 'Summarize')
    setBaseSubtitle('')
  }
  if (!streaming || state.status.trim().length > 0) setStatus(state.status)
  maybeShowSetup(state)
}

function handleBgMessage(msg: BgToPanel) {
  switch (msg.type) {
    case 'ui:state':
      currentState = msg.state
      updateControls(msg.state)
      return
    case 'ui:status':
      if (!streaming || msg.status.trim().length > 0) setStatus(msg.status)
      return
    case 'run:error':
      setStatus(`Error: ${msg.message}`)
      return
    case 'run:start':
      void startStream(msg.run)
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

summarizeBtn.addEventListener('click', () => send({ type: 'panel:summarize' }))
refreshBtn.addEventListener('click', () => send({ type: 'panel:summarize', refresh: true }))
drawerToggleBtn.addEventListener('click', () => toggleDrawer())
advancedBtn.addEventListener('click', () => send({ type: 'panel:openOptions' }))

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
  autoToggle.update({
    id: 'sidepanel-auto',
    label: 'Auto summarize',
    checked: autoValue,
    onCheckedChange: (checked) => {
      autoValue = checked
      send({ type: 'panel:setAuto', value: checked })
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

async function startStream(run: RunStart) {
  const token = (await loadSettings()).token.trim()
  if (!token) {
    setStatus('Setup required (missing token)')
    return
  }

  streamController?.abort()
  const controller = new AbortController()
  streamController = controller
  streaming = true
  streamedAnyNonWhitespace = false
  rememberedUrl = false
  currentSource = { url: run.url, title: run.title }
  summaryFromCache = null

  markdown = ''
  renderEl.innerHTML = ''
  metricsEl.textContent = ''
  metricsEl.classList.add('hidden')
  metricsEl.removeAttribute('data-details')
  metricsEl.removeAttribute('title')
  lastMeta = { inputSummary: null, model: null, modelLabel: null }
  setBaseTitle(run.title || run.url)
  setBaseSubtitle('')
  setStatus('Connecting…')

  try {
    const res = await fetch(`http://127.0.0.1:8787/v1/summarize/${run.id}/events`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: controller.signal,
    })
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
    if (!res.body) throw new Error('Missing stream body')

    setStatus('Summarizing…')

    for await (const msg of parseSseStream(res.body)) {
      if (controller.signal.aborted) return

      if (msg.event === 'chunk') {
        const data = JSON.parse(msg.data) as { text: string }
        const merged = mergeStreamText(markdown, data.text)
        if (merged !== markdown) {
          markdown = merged
          queueRender()
        }

        if (!streamedAnyNonWhitespace && data.text.trim().length > 0) {
          streamedAnyNonWhitespace = true
          if (!rememberedUrl) {
            rememberedUrl = true
            send({ type: 'panel:rememberUrl', url: run.url })
          }
        }
      } else if (msg.event === 'meta') {
        const data = JSON.parse(msg.data) as {
          model?: string | null
          modelLabel?: string | null
          inputSummary?: string | null
          summaryFromCache?: boolean | null
        }
        lastMeta = {
          model: typeof data.model === 'string' ? data.model : lastMeta.model,
          modelLabel: typeof data.modelLabel === 'string' ? data.modelLabel : lastMeta.modelLabel,
          inputSummary:
            typeof data.inputSummary === 'string' ? data.inputSummary : lastMeta.inputSummary,
        }
        if (typeof data.summaryFromCache === 'boolean') {
          summaryFromCache = data.summaryFromCache
          if (summaryFromCache) {
            stopProgress()
          } else if (streaming && !showProgress) {
            armProgress()
          }
        }
        setBaseSubtitle(
          buildIdleSubtitle({
            inputSummary: lastMeta.inputSummary,
            modelLabel: lastMeta.modelLabel,
            model: lastMeta.model,
          })
        )
      } else if (msg.event === 'status') {
        const data = JSON.parse(msg.data) as { text: string }
        if (!streamedAnyNonWhitespace) setStatus(data.text)
      } else if (msg.event === 'metrics') {
        const data = JSON.parse(msg.data) as {
          summary: string
          details: string | null
          summaryDetailed: string
          detailsDetailed: string | null
          elapsedMs: number
        }
        renderMetricsSummary(data.summary)
        metricsEl.removeAttribute('title')
        metricsEl.removeAttribute('data-details')
        metricsEl.classList.remove('hidden')
      } else if (msg.event === 'error') {
        const data = JSON.parse(msg.data) as { message: string }
        throw new Error(data.message)
      } else if (msg.event === 'done') {
        break
      }
    }

    if (!streamedAnyNonWhitespace) {
      throw new Error('Model returned no output.')
    }

    setStatus('')
  } catch (err) {
    if (controller.signal.aborted) return
    const message = friendlyFetchError(err, 'Stream failed')
    setStatus(`Error: ${message}`)
  } finally {
    if (streamController === controller) {
      streaming = false
      stopProgress()
      void syncWithActiveTab()
    }
  }
}
