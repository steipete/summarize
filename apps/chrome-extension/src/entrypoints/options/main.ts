import { readPresetOrCustomValue, resolvePresetOrCustom } from '../../lib/combo'
import { defaultSettings, loadSettings, saveSettings } from '../../lib/settings'
import { applyTheme, type ColorMode, type ColorScheme } from '../../lib/theme'
import { mountOptionsPickers } from './pickers'

declare const __SUMMARIZE_GIT_HASH__: string
declare const __SUMMARIZE_VERSION__: string

function byId<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id)
  if (!el) throw new Error(`Missing #${id}`)
  return el as T
}

const formEl = byId<HTMLFormElement>('form')
const statusEl = byId<HTMLSpanElement>('status')

const tokenEl = byId<HTMLInputElement>('token')
const modelPresetEl = byId<HTMLSelectElement>('modelPreset')
const modelCustomEl = byId<HTMLInputElement>('modelCustom')
const languagePresetEl = byId<HTMLSelectElement>('languagePreset')
const languageCustomEl = byId<HTMLInputElement>('languageCustom')
const promptOverrideEl = byId<HTMLTextAreaElement>('promptOverride')
const autoEl = byId<HTMLInputElement>('auto')
const maxCharsEl = byId<HTMLInputElement>('maxChars')
const pickersRoot = byId<HTMLDivElement>('pickersRoot')
const fontFamilyEl = byId<HTMLInputElement>('fontFamily')
const fontSizeEl = byId<HTMLInputElement>('fontSize')
const buildInfoEl = document.getElementById('buildInfo')
const daemonStatusEl = byId<HTMLDivElement>('daemonStatus')

const setStatus = (text: string) => {
  statusEl.textContent = text
}

const setBuildInfo = () => {
  if (!buildInfoEl) return
  const version =
    typeof __SUMMARIZE_VERSION__ === 'string' && __SUMMARIZE_VERSION__
      ? __SUMMARIZE_VERSION__
      : chrome?.runtime?.getManifest?.().version
  const hash = typeof __SUMMARIZE_GIT_HASH__ === 'string' ? __SUMMARIZE_GIT_HASH__ : ''
  const parts: string[] = []
  if (version) parts.push(`v${version}`)
  if (hash && hash !== 'unknown') parts.push(hash)
  buildInfoEl.textContent = parts.join(' · ')
  buildInfoEl.toggleAttribute('hidden', parts.length === 0)
}

const resolveExtensionVersion = () => {
  const injected =
    typeof __SUMMARIZE_VERSION__ === 'string' && __SUMMARIZE_VERSION__ ? __SUMMARIZE_VERSION__ : ''
  return injected || chrome?.runtime?.getManifest?.().version || ''
}

const setDaemonStatus = (text: string, state?: 'ok' | 'warn' | 'error') => {
  daemonStatusEl.textContent = text
  if (state) {
    daemonStatusEl.dataset.state = state
  } else {
    delete daemonStatusEl.dataset.state
  }
}

let daemonCheckId = 0
async function checkDaemonStatus(token: string) {
  const trimmedToken = token.trim()
  if (!trimmedToken) {
    setDaemonStatus('Add token to verify daemon', 'warn')
    return
  }

  daemonCheckId += 1
  const checkId = daemonCheckId
  setDaemonStatus('Checking daemon…')

  const controller = new AbortController()
  const timeout = window.setTimeout(() => controller.abort(), 1500)
  try {
    const res = await fetch('http://127.0.0.1:8787/health', { signal: controller.signal })
    window.clearTimeout(timeout)
    if (checkId !== daemonCheckId) return
    if (!res.ok) {
      setDaemonStatus(`Daemon error (${res.status} ${res.statusText})`, 'error')
      return
    }
    const json = (await res.json()) as { version?: unknown }
    const daemonVersion = typeof json.version === 'string' ? json.version.trim() : ''
    const extVersion = resolveExtensionVersion()
    const versionNote = daemonVersion ? `v${daemonVersion}` : 'version unknown'

    if (trimmedToken) {
      try {
        const ping = await fetch('http://127.0.0.1:8787/v1/ping', {
          signal: controller.signal,
          headers: { Authorization: `Bearer ${trimmedToken}` },
        })
        if (checkId !== daemonCheckId) return
        if (!ping.ok) {
          setDaemonStatus(`Daemon ${versionNote} (token mismatch)`, 'warn')
          return
        }
      } catch {
        if (checkId !== daemonCheckId) return
        setDaemonStatus(`Daemon ${versionNote} (auth failed)`, 'warn')
        return
      }
    } else {
      setDaemonStatus(`Daemon ${versionNote} (add token to verify)`, 'warn')
      return
    }

    if (daemonVersion && extVersion && daemonVersion !== extVersion) {
      setDaemonStatus(`Daemon ${versionNote} (extension v${extVersion})`, 'warn')
      return
    }

    setDaemonStatus(`Daemon ${versionNote} connected`, 'ok')
  } catch {
    window.clearTimeout(timeout)
    if (checkId !== daemonCheckId) return
    setDaemonStatus('Daemon unreachable', 'error')
  }
}

function setDefaultModelPresets() {
  modelPresetEl.innerHTML = ''
  {
    const auto = document.createElement('option')
    auto.value = 'auto'
    auto.textContent = 'Auto'
    modelPresetEl.append(auto)
  }
  {
    const custom = document.createElement('option')
    custom.value = 'custom'
    custom.textContent = 'Custom…'
    modelPresetEl.append(custom)
  }
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

function setModelValue(value: string) {
  const next = value.trim() || defaultSettings.model
  const optionValues = new Set(Array.from(modelPresetEl.options).map((o) => o.value))
  if (optionValues.has(next) && next !== 'custom') {
    modelPresetEl.value = next
    modelCustomEl.hidden = true
    return
  }
  modelPresetEl.value = 'custom'
  modelCustomEl.hidden = false
  modelCustomEl.value = next
}

async function refreshModelPresets(token: string) {
  const previousModel = readCurrentModelValue()
  const trimmed = token.trim()
  if (!trimmed) {
    setDefaultModelPresets()
    setModelPlaceholderFromDiscovery({})
    setModelValue(previousModel)
    return
  }
  try {
    const res = await fetch('http://127.0.0.1:8787/v1/models', {
      headers: { Authorization: `Bearer ${trimmed}` },
    })
    if (!res.ok) {
      setDefaultModelPresets()
      setModelValue(previousModel)
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
      setModelValue(previousModel)
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
    setModelValue(previousModel)
  } catch {
    // ignore
  }
}

const languagePresets = [
  'auto',
  'en',
  'de',
  'es',
  'fr',
  'it',
  'pt',
  'nl',
  'sv',
  'no',
  'da',
  'fi',
  'pl',
  'cs',
  'tr',
  'ru',
  'uk',
  'ar',
  'hi',
  'ja',
  'ko',
  'zh-cn',
  'zh-tw',
]

let currentScheme: ColorScheme = defaultSettings.colorScheme
let currentMode: ColorMode = defaultSettings.colorMode

const pickerHandlers = {
  onSchemeChange: (value: ColorScheme) => {
    currentScheme = value
    applyTheme({ scheme: currentScheme, mode: currentMode })
  },
  onModeChange: (value: ColorMode) => {
    currentMode = value
    applyTheme({ scheme: currentScheme, mode: currentMode })
  },
}

const pickers = mountOptionsPickers(pickersRoot, {
  scheme: currentScheme,
  mode: currentMode,
  ...pickerHandlers,
})

async function load() {
  const s = await loadSettings()
  tokenEl.value = s.token
  void checkDaemonStatus(s.token)
  await refreshModelPresets(s.token)
  setModelValue(s.model)
  {
    const resolved = resolvePresetOrCustom({ value: s.language, presets: languagePresets })
    languagePresetEl.value = resolved.presetValue
    languageCustomEl.hidden = !resolved.isCustom
    languageCustomEl.value = resolved.customValue
  }
  promptOverrideEl.value = s.promptOverride
  autoEl.checked = s.autoSummarize
  maxCharsEl.value = String(s.maxChars)
  fontFamilyEl.value = s.fontFamily
  fontSizeEl.value = String(s.fontSize)
  currentScheme = s.colorScheme
  currentMode = s.colorMode
  pickers.update({ scheme: currentScheme, mode: currentMode, ...pickerHandlers })
  applyTheme({ scheme: s.colorScheme, mode: s.colorMode })
}

let refreshTimer = 0
tokenEl.addEventListener('input', () => {
  window.clearTimeout(refreshTimer)
  refreshTimer = window.setTimeout(() => {
    void refreshModelPresets(tokenEl.value)
    void checkDaemonStatus(tokenEl.value)
  }, 350)
})

let modelRefreshAt = 0
const refreshModelsIfStale = () => {
  const now = Date.now()
  if (now - modelRefreshAt < 1500) return
  modelRefreshAt = now
  void refreshModelPresets(tokenEl.value)
}

modelPresetEl.addEventListener('focus', refreshModelsIfStale)
modelPresetEl.addEventListener('pointerdown', refreshModelsIfStale)
modelCustomEl.addEventListener('focus', refreshModelsIfStale)
modelCustomEl.addEventListener('pointerdown', refreshModelsIfStale)

languagePresetEl.addEventListener('change', () => {
  languageCustomEl.hidden = languagePresetEl.value !== 'custom'
  if (!languageCustomEl.hidden) languageCustomEl.focus()
})

modelPresetEl.addEventListener('change', () => {
  modelCustomEl.hidden = modelPresetEl.value !== 'custom'
  if (!modelCustomEl.hidden) modelCustomEl.focus()
})

formEl.addEventListener('submit', (e) => {
  e.preventDefault()
  void (async () => {
    setStatus('Saving…')
    const current = await loadSettings()
    await saveSettings({
      token: tokenEl.value || defaultSettings.token,
      model: readCurrentModelValue(),
      length: current.length,
      language: readPresetOrCustomValue({
        presetValue: languagePresetEl.value,
        customValue: languageCustomEl.value,
        defaultValue: defaultSettings.language,
      }),
      promptOverride: promptOverrideEl.value || defaultSettings.promptOverride,
      autoSummarize: autoEl.checked,
      maxChars: Number(maxCharsEl.value) || defaultSettings.maxChars,
      colorScheme: currentScheme || defaultSettings.colorScheme,
      colorMode: currentMode || defaultSettings.colorMode,
      fontFamily: fontFamilyEl.value || defaultSettings.fontFamily,
      fontSize: Number(fontSizeEl.value) || defaultSettings.fontSize,
    })
    setStatus('Saved')
    setTimeout(() => setStatus(''), 900)
  })()
})

setBuildInfo()
void load()
