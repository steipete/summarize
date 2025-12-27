import MarkdownIt from 'markdown-it'

import { readPresetOrCustomValue, resolvePresetOrCustom } from '../../lib/combo'
import { buildIdleSubtitle } from '../../lib/header'
import { defaultSettings, loadSettings, patchSettings } from '../../lib/settings'
import { parseSseStream } from '../../lib/sse'
import { splitStatusPercent } from '../../lib/status'
import { applyTheme, type ColorMode, type ColorScheme } from '../../lib/theme'
import { generateToken } from '../../lib/token'

type PanelToBg =
  | { type: 'panel:ready' }
  | { type: 'panel:summarize' }
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
const advancedBtn = byId<HTMLButtonElement>('advanced')
const autoEl = byId<HTMLInputElement>('auto')
const lengthPresetEl = byId<HTMLSelectElement>('lengthPreset')
const lengthCustomEl = byId<HTMLInputElement>('lengthCustom')
const sizeEl = byId<HTMLInputElement>('size')
const schemeTriggerEl = byId<HTMLButtonElement>('schemeTrigger')
const schemeLabelEl = byId<HTMLSpanElement>('schemeLabel')
const schemeChipsEl = byId<HTMLSpanElement>('schemeChips')
const schemeListEl = byId<HTMLDivElement>('schemeList')
const schemeOptions = Array.from(schemeListEl.querySelectorAll<HTMLButtonElement>('.pickerOption'))
const modeTriggerEl = byId<HTMLButtonElement>('modeTrigger')
const modeLabelEl = byId<HTMLSpanElement>('modeLabel')
const modeListEl = byId<HTMLDivElement>('modeList')
const modeOptions = Array.from(modeListEl.querySelectorAll<HTMLButtonElement>('.pickerOption'))
const fontTriggerEl = byId<HTMLButtonElement>('fontTrigger')
const fontLabelEl = byId<HTMLSpanElement>('fontLabel')
const fontListEl = byId<HTMLDivElement>('fontList')
const fontOptions = Array.from(fontListEl.querySelectorAll<HTMLButtonElement>('.pickerOption'))

const md = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: false,
})

let markdown = ''
let renderQueued = 0
let currentState: UiState | null = null
let currentSource: { url: string; title: string | null } | null = null
let streamController: AbortController | null = null
let streamedAnyNonWhitespace = false
let rememberedUrl = false
let streaming = false
let baseTitle = 'Summarize'
let baseSubtitle = ''
let statusText = ''
let lastMeta: { inputSummary: string | null; model: string | null; modelLabel: string | null } = {
  inputSummary: null,
  model: null,
  modelLabel: null,
}
let drawerAnimation: Animation | null = null

const lengthPresets = ['short', 'medium', 'long', 'xl', 'xxl', '20k']

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

  titleEl.textContent = baseTitle
  headerEl.classList.toggle('isError', isError)
  headerEl.classList.toggle('isRunning', showStatus && !isError)
  headerEl.classList.toggle('isIndeterminate', showStatus && !isError && percentNum == null)

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

  progressFillEl.style.display = showStatus ? '' : 'none'
  subtitleEl.textContent = showStatus ? split.text || trimmed : baseSubtitle
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

type PickerState = {
  el: HTMLElement
  trigger: HTMLButtonElement
  list: HTMLElement
  isOpen: () => boolean
  close: () => void
}

const pickerStates: PickerState[] = []

function closeAllPickers(except?: PickerState) {
  pickerStates.forEach((state) => {
    if (state !== except) state.close()
  })
}

document.addEventListener('click', (event) => {
  const target = event.target as Node
  pickerStates.forEach((state) => {
    if (state.isOpen() && !state.el.contains(target)) state.close()
  })
})

document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return
  const openState = pickerStates.find((state) => state.isOpen())
  if (!openState) return
  event.preventDefault()
  openState.close()
  openState.trigger.focus()
})

function createPicker<T extends string>(opts: {
  pickerEl: HTMLElement
  triggerEl: HTMLButtonElement
  labelEl: HTMLElement
  listEl: HTMLElement
  options: HTMLButtonElement[]
  getLabel: (value: T) => string
  renderValue?: (value: T) => void
  onSelect: (value: T) => void
  initialValue: T
}) {
  const { pickerEl, triggerEl, labelEl, listEl, options, getLabel, renderValue, onSelect } = opts
  let current = opts.initialValue

  const setOpen = (open: boolean) => {
    pickerEl.setAttribute('data-open', open ? 'true' : 'false')
    triggerEl.setAttribute('aria-expanded', open ? 'true' : 'false')
    if (open) listEl.focus()
  }

  const state: PickerState = {
    el: pickerEl,
    trigger: triggerEl,
    list: listEl,
    isOpen: () => pickerEl.getAttribute('data-open') === 'true',
    close: () => setOpen(false),
  }
  pickerStates.push(state)

  function setValue(value: T) {
    current = value
    labelEl.textContent = getLabel(value)
    renderValue?.(value)
    options.forEach((option) => {
      const selected = option.dataset.value === value
      option.classList.toggle('isSelected', selected)
      option.setAttribute('aria-selected', selected ? 'true' : 'false')
    })
  }

  triggerEl.addEventListener('click', () => {
    const open = state.isOpen()
    if (!open) closeAllPickers(state)
    setOpen(!open)
  })

  options.forEach((option) => {
    option.addEventListener('click', () => {
      const value = option.dataset.value as T | undefined
      if (!value) return
      setValue(value)
      onSelect(value)
      setOpen(false)
    })
  })

  setValue(opts.initialValue)

  return {
    setValue,
    getValue: () => current,
  }
}

const schemeLabels: Record<ColorScheme, string> = {
  slate: 'Slate',
  cedar: 'Cedar',
  mint: 'Mint',
  ocean: 'Ocean',
  ember: 'Ember',
  iris: 'Iris',
}

const modeLabels: Record<ColorMode, string> = {
  system: 'System',
  light: 'Light',
  dark: 'Dark',
}

const fontLabels = new Map<string, string>([
  ['-apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif', 'SF'],
  ['Georgia, serif', 'Georgia'],
  ['Iowan Old Style, Palatino, serif', 'Iowan'],
  ['ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace', 'Mono'],
])

const schemePickerEl = schemeTriggerEl.closest('.picker')
if (!schemePickerEl) throw new Error('Missing scheme picker')
const modePickerEl = modeTriggerEl.closest('.picker')
if (!modePickerEl) throw new Error('Missing mode picker')
const fontPickerEl = fontTriggerEl.closest('.picker')
if (!fontPickerEl) throw new Error('Missing font picker')

const _schemePicker = createPicker<ColorScheme>({
  pickerEl: schemePickerEl,
  triggerEl: schemeTriggerEl,
  labelEl: schemeLabelEl,
  listEl: schemeListEl,
  options: schemeOptions,
  getLabel: (value) => schemeLabels[value] ?? 'Custom',
  renderValue: (value) => {
    schemeChipsEl.className = `scheme-chips scheme-${value}`
  },
  onSelect: (value) => {
    void (async () => {
      const next = await patchSettings({ colorScheme: value })
      applyTheme({ scheme: next.colorScheme, mode: next.colorMode })
    })()
  },
  initialValue: 'slate',
})

const _modePicker = createPicker<ColorMode>({
  pickerEl: modePickerEl,
  triggerEl: modeTriggerEl,
  labelEl: modeLabelEl,
  listEl: modeListEl,
  options: modeOptions,
  getLabel: (value) => modeLabels[value] ?? 'System',
  onSelect: (value) => {
    void (async () => {
      const next = await patchSettings({ colorMode: value })
      applyTheme({ scheme: next.colorScheme, mode: next.colorMode })
    })()
  },
  initialValue: 'system',
})

const _fontPicker = createPicker<string>({
  pickerEl: fontPickerEl,
  triggerEl: fontTriggerEl,
  labelEl: fontLabelEl,
  listEl: fontListEl,
  options: fontOptions,
  getLabel: (value) => fontLabels.get(value) ?? 'Custom',
  renderValue: (value) => {
    fontLabelEl.title = value
  },
  onSelect: (value) => {
    void (async () => {
      const next = await patchSettings({ fontFamily: value })
      applyTypography(next.fontFamily, next.fontSize)
    })()
  },
  initialValue: '-apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif',
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
      <p class="setup__hint">Homebrew + LaunchAgent are macOS-only.</p>
    `

  const daemonIntro = isMac
    ? `
      <p><strong>2) Register the daemon (LaunchAgent)</strong></p>
      <code>${daemonCmd}</code>
    `
    : `
      <p><strong>2) Daemon auto-start</strong></p>
      <p class="setup__hint">No Linux/Windows service support yet in summarize.</p>
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
    : `
      <div class="row">
        <button id="copy-npm" type="button">Copy npm</button>
        <button id="regen" type="button">Regenerate Token</button>
      </div>
    `

  const troubleshooting =
    showTroubleshooting && isMac
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
  autoEl.checked = state.settings.autoSummarize
  {
    const resolved = resolvePresetOrCustom({ value: state.settings.length, presets: lengthPresets })
    lengthPresetEl.value = resolved.presetValue
    lengthCustomEl.hidden = !resolved.isCustom
    lengthCustomEl.value = resolved.customValue
  }
  if (currentSource && state.tab.url && state.tab.url !== currentSource.url && !streaming) {
    currentSource = null
  }
  if (!currentSource) {
    lastMeta = { inputSummary: null, model: null, modelLabel: null }
    setBaseTitle(state.tab.title || state.tab.url || 'Summarize')
    setBaseSubtitle('')
  }
  setStatus(state.status)
  maybeShowSetup(state)
}

function handleBgMessage(msg: BgToPanel) {
  switch (msg.type) {
    case 'ui:state':
      currentState = msg.state
      updateControls(msg.state)
      return
    case 'ui:status':
      setStatus(msg.status)
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
drawerToggleBtn.addEventListener('click', () => toggleDrawer())
advancedBtn.addEventListener('click', () => send({ type: 'panel:openOptions' }))

autoEl.addEventListener('change', () => send({ type: 'panel:setAuto', value: autoEl.checked }))
lengthPresetEl.addEventListener('change', () => {
  lengthCustomEl.hidden = lengthPresetEl.value !== 'custom'
  if (!lengthCustomEl.hidden) {
    lengthCustomEl.focus()
    return
  }
  send({ type: 'panel:setLength', value: lengthPresetEl.value || defaultSettings.length })
})
lengthCustomEl.addEventListener('change', () => {
  if (lengthPresetEl.value !== 'custom') return
  send({
    type: 'panel:setLength',
    value: readPresetOrCustomValue({
      presetValue: lengthPresetEl.value,
      customValue: lengthCustomEl.value,
      defaultValue: defaultSettings.length,
    }),
  })
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
  autoEl.checked = s.autoSummarize
  {
    const resolved = resolvePresetOrCustom({ value: s.length, presets: lengthPresets })
    lengthPresetEl.value = resolved.presetValue
    lengthCustomEl.hidden = !resolved.isCustom
    lengthCustomEl.value = resolved.customValue
  }
  fontPicker.setValue(s.fontFamily)
  modePicker.setValue(s.colorMode)
  schemePicker.setValue(s.colorScheme)
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
        }
        lastMeta = {
          model: typeof data.model === 'string' ? data.model : lastMeta.model,
          modelLabel: typeof data.modelLabel === 'string' ? data.modelLabel : lastMeta.modelLabel,
          inputSummary:
            typeof data.inputSummary === 'string' ? data.inputSummary : lastMeta.inputSummary,
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
        metricsEl.textContent = data.summary
        const tooltipParts = [data.summaryDetailed, data.detailsDetailed, data.details]
          .filter((p): p is string => typeof p === 'string' && p.trim().length > 0)
          .slice(0, 2)
        const tooltip = tooltipParts.join('\n')
        if (tooltip) {
          metricsEl.setAttribute('title', tooltip)
          metricsEl.setAttribute('data-details', '1')
        }
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
    if (streamController === controller) streaming = false
  }
}
