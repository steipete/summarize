import { readPresetOrCustomValue, resolvePresetOrCustom } from '../../lib/combo'
import { defaultSettings, loadSettings, saveSettings } from '../../lib/settings'
import { applyTheme, type ColorMode, type ColorScheme } from '../../lib/theme'

function byId<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id)
  if (!el) throw new Error(`Missing #${id}`)
  return el as T
}

const formEl = byId<HTMLFormElement>('form')
const statusEl = byId<HTMLSpanElement>('status')

const tokenEl = byId<HTMLInputElement>('token')
const modelEl = byId<HTMLInputElement>('model')
const modelPresetsEl = byId<HTMLDataListElement>('modelPresets')
const languagePresetEl = byId<HTMLSelectElement>('languagePreset')
const languageCustomEl = byId<HTMLInputElement>('languageCustom')
const promptOverrideEl = byId<HTMLTextAreaElement>('promptOverride')
const autoEl = byId<HTMLInputElement>('auto')
const maxCharsEl = byId<HTMLInputElement>('maxChars')
const schemeTriggerEl = byId<HTMLButtonElement>('schemeTrigger')
const schemeLabelEl = byId<HTMLSpanElement>('schemeLabel')
const schemeChipsEl = byId<HTMLSpanElement>('schemeChips')
const schemeListEl = byId<HTMLDivElement>('schemeList')
const schemeOptions = Array.from(schemeListEl.querySelectorAll<HTMLButtonElement>('.pickerOption'))
const colorModeEl = byId<HTMLSelectElement>('colorMode')
const fontFamilyEl = byId<HTMLInputElement>('fontFamily')
const fontSizeEl = byId<HTMLInputElement>('fontSize')

const setStatus = (text: string) => {
  statusEl.textContent = text
}

async function refreshModelPresets(token: string) {
  const trimmed = token.trim()
  if (!trimmed) return
  try {
    const res = await fetch('http://127.0.0.1:8787/v1/models', {
      headers: { Authorization: `Bearer ${trimmed}` },
    })
    if (!res.ok) return
    const json = (await res.json()) as unknown
    if (!json || typeof json !== 'object') return
    const obj = json as Record<string, unknown>
    if (obj.ok !== true) return
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

    if (options.length === 0) return

    modelPresetsEl.innerHTML = ''
    for (const opt of options) {
      const el = document.createElement('option')
      el.value = opt.id
      if (opt.label) el.label = opt.label
      modelPresetsEl.append(el)
    }
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

const schemeLabels: Record<ColorScheme, string> = {
  slate: 'Slate',
  cedar: 'Cedar',
  mint: 'Mint',
  ocean: 'Ocean',
  ember: 'Ember',
  iris: 'Iris',
}

let currentScheme: ColorScheme = defaultSettings.colorScheme

const schemePickerEl = schemeTriggerEl.closest('.picker')
if (!schemePickerEl) throw new Error('Missing scheme picker')

function setSchemeOpen(open: boolean) {
  schemePickerEl.setAttribute('data-open', open ? 'true' : 'false')
  schemeTriggerEl.setAttribute('aria-expanded', open ? 'true' : 'false')
  if (open) schemeListEl.focus()
}

function setSchemeUi(scheme: ColorScheme) {
  currentScheme = scheme
  schemeLabelEl.textContent = schemeLabels[scheme]
  schemeChipsEl.className = `scheme-chips scheme-${scheme}`
  schemeOptions.forEach((option) => {
    const selected = option.dataset.value === scheme
    option.classList.toggle('isSelected', selected)
    option.setAttribute('aria-selected', selected ? 'true' : 'false')
  })
}

async function load() {
  const s = await loadSettings()
  tokenEl.value = s.token
  modelEl.value = s.model
  await refreshModelPresets(s.token)
  {
    const resolved = resolvePresetOrCustom({ value: s.language, presets: languagePresets })
    languagePresetEl.value = resolved.presetValue
    languageCustomEl.hidden = !resolved.isCustom
    languageCustomEl.value = resolved.customValue
  }
  promptOverrideEl.value = s.promptOverride
  autoEl.checked = s.autoSummarize
  maxCharsEl.value = String(s.maxChars)
  colorModeEl.value = s.colorMode
  fontFamilyEl.value = s.fontFamily
  fontSizeEl.value = String(s.fontSize)
  setSchemeUi(s.colorScheme)
  applyTheme({ scheme: s.colorScheme, mode: s.colorMode })
}

languagePresetEl.addEventListener('change', () => {
  languageCustomEl.hidden = languagePresetEl.value !== 'custom'
  if (!languageCustomEl.hidden) languageCustomEl.focus()
})
colorModeEl.addEventListener('change', () =>
  applyTheme({
    scheme: currentScheme,
    mode: colorModeEl.value as ColorMode,
  })
)

schemeTriggerEl.addEventListener('click', () => {
  const open = schemePickerEl.getAttribute('data-open') === 'true'
  setSchemeOpen(!open)
})

schemeOptions.forEach((option) => {
  option.addEventListener('click', () => {
    const value = option.dataset.value as ColorScheme | undefined
    if (!value) return
    setSchemeUi(value)
    applyTheme({ scheme: value, mode: colorModeEl.value as ColorMode })
    setSchemeOpen(false)
  })
})

document.addEventListener('click', (event) => {
  if (schemePickerEl.getAttribute('data-open') !== 'true') return
  const target = event.target as Node
  if (!schemePickerEl.contains(target)) setSchemeOpen(false)
})

document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return
  if (schemePickerEl.getAttribute('data-open') !== 'true') return
  event.preventDefault()
  setSchemeOpen(false)
  schemeTriggerEl.focus()
})

formEl.addEventListener('submit', (e) => {
  e.preventDefault()
  void (async () => {
    setStatus('Saving…')
    const current = await loadSettings()
    await saveSettings({
      token: tokenEl.value || defaultSettings.token,
      model: modelEl.value || defaultSettings.model,
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
      colorMode: (colorModeEl.value as ColorMode) || defaultSettings.colorMode,
      fontFamily: fontFamilyEl.value || defaultSettings.fontFamily,
      fontSize: Number(fontSizeEl.value) || defaultSettings.fontSize,
    })
    setStatus('Saved')
    setTimeout(() => setStatus(''), 900)
  })()
})

void load()
