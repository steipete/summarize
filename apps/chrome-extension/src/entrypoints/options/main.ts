import {
  deleteSkill,
  getSkill,
  listSkills,
  type Skill,
  saveSkill,
} from '../../automation/skills-store'
import { buildUserScriptsGuidance, getUserScriptsStatus } from '../../automation/userscripts'
import { readPresetOrCustomValue, resolvePresetOrCustom } from '../../lib/combo'
import { defaultSettings, loadSettings, patchSettings, saveSettings } from '../../lib/settings'
import { applyTheme, type ColorMode, type ColorScheme } from '../../lib/theme'
import { mountCheckbox } from '../../ui/zag-checkbox'
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
const tokenCopyBtn = byId<HTMLButtonElement>('tokenCopy')
const modelPresetEl = byId<HTMLSelectElement>('modelPreset')
const modelCustomEl = byId<HTMLInputElement>('modelCustom')
const languagePresetEl = byId<HTMLSelectElement>('languagePreset')
const languageCustomEl = byId<HTMLInputElement>('languageCustom')
const promptOverrideEl = byId<HTMLTextAreaElement>('promptOverride')
const autoToggleRoot = byId<HTMLDivElement>('autoToggle')
const maxCharsEl = byId<HTMLInputElement>('maxChars')
const advancedFieldsEl = byId<HTMLDivElement>('advancedFields')
const advancedToggleEl = byId<HTMLButtonElement>('advancedToggle')
const hoverPromptEl = byId<HTMLTextAreaElement>('hoverPrompt')
const hoverPromptResetBtn = byId<HTMLButtonElement>('hoverPromptReset')
const chatToggleRoot = byId<HTMLDivElement>('chatToggle')
const automationToggleRoot = byId<HTMLDivElement>('automationToggle')
const automationPermissionsBtn = byId<HTMLButtonElement>('automationPermissions')
const userScriptsNoticeEl = byId<HTMLDivElement>('userScriptsNotice')
const skillsExportBtn = byId<HTMLButtonElement>('skillsExport')
const skillsImportBtn = byId<HTMLButtonElement>('skillsImport')
const skillsSearchEl = byId<HTMLInputElement>('skillsSearch')
const skillsListEl = byId<HTMLDivElement>('skillsList')
const skillsEmptyEl = byId<HTMLDivElement>('skillsEmpty')
const skillsConflictsEl = byId<HTMLDivElement>('skillsImportConflicts')
const hoverSummariesToggleRoot = byId<HTMLDivElement>('hoverSummariesToggle')
const summaryTimestampsToggleRoot = byId<HTMLDivElement>('summaryTimestampsToggle')
const extendedLoggingToggleRoot = byId<HTMLDivElement>('extendedLoggingToggle')
const requestModeEl = byId<HTMLSelectElement>('requestMode')
const firecrawlModeEl = byId<HTMLSelectElement>('firecrawlMode')
const markdownModeEl = byId<HTMLSelectElement>('markdownMode')
const preprocessModeEl = byId<HTMLSelectElement>('preprocessMode')
const youtubeModeEl = byId<HTMLSelectElement>('youtubeMode')
const transcriberEl = byId<HTMLSelectElement>('transcriber')
const timeoutEl = byId<HTMLInputElement>('timeout')
const retriesEl = byId<HTMLInputElement>('retries')
const maxOutputTokensEl = byId<HTMLInputElement>('maxOutputTokens')
const pickersRoot = byId<HTMLDivElement>('pickersRoot')
const fontFamilyEl = byId<HTMLInputElement>('fontFamily')
const fontSizeEl = byId<HTMLInputElement>('fontSize')
const buildInfoEl = document.getElementById('buildInfo')
const daemonStatusEl = byId<HTMLDivElement>('daemonStatus')
const tabsRoot = byId<HTMLDivElement>('tabs')
const tabButtons = Array.from(tabsRoot.querySelectorAll<HTMLButtonElement>('[data-tab]'))
const tabPanels = Array.from(document.querySelectorAll<HTMLElement>('[data-tab-panel]'))

const tabStorageKey = 'summarize:options-tab'
const tabIds = new Set(tabButtons.map((button) => button.dataset.tab).filter(Boolean))

const setActiveTab = (next: string) => {
  if (!tabIds.has(next)) return
  for (const button of tabButtons) {
    const isActive = button.dataset.tab === next
    button.setAttribute('aria-selected', isActive ? 'true' : 'false')
    button.tabIndex = isActive ? 0 : -1
  }
  for (const panel of tabPanels) {
    const isActive = panel.dataset.tabPanel === next
    panel.hidden = !isActive
  }
  localStorage.setItem(tabStorageKey, next)
}

const storedTab = localStorage.getItem(tabStorageKey)
const initialTab = storedTab && tabIds.has(storedTab) ? storedTab : 'general'
setActiveTab(initialTab)

tabButtons.forEach((button) => {
  button.addEventListener('click', () => {
    const tab = button.dataset.tab
    if (tab) setActiveTab(tab)
  })
})

tabsRoot.addEventListener('keydown', (event) => {
  if (!(event instanceof KeyboardEvent)) return
  const keys = ['ArrowLeft', 'ArrowRight', 'Home', 'End']
  if (!keys.includes(event.key)) return
  event.preventDefault()
  const currentIndex = tabButtons.findIndex(
    (button) => button.getAttribute('aria-selected') === 'true'
  )
  if (currentIndex < 0) return
  const lastIndex = tabButtons.length - 1
  let nextIndex = currentIndex
  if (event.key === 'ArrowLeft') nextIndex = currentIndex === 0 ? lastIndex : currentIndex - 1
  if (event.key === 'ArrowRight') nextIndex = currentIndex === lastIndex ? 0 : currentIndex + 1
  if (event.key === 'Home') nextIndex = 0
  if (event.key === 'End') nextIndex = lastIndex
  const nextButton = tabButtons[nextIndex]
  if (!nextButton) return
  const nextTab = nextButton.dataset.tab
  if (!nextTab) return
  setActiveTab(nextTab)
  nextButton.focus()
})

let autoValue = defaultSettings.autoSummarize
let chatEnabledValue = defaultSettings.chatEnabled
let automationEnabledValue = defaultSettings.automationEnabled
let hoverSummariesValue = defaultSettings.hoverSummaries
let summaryTimestampsValue = defaultSettings.summaryTimestamps
let extendedLoggingValue = defaultSettings.extendedLogging
let advancedOpen = false

let skillsCache: Skill[] = []
let skillsFiltered: Skill[] = []
let skillsSearchQuery = ''
let editingSkill: Skill | null = null
let importConflicts: Array<{ skill: Skill; selected: boolean }> = []
let importedSkills: Skill[] = []

const setStatus = (text: string) => {
  statusEl.textContent = text
}

let statusTimer = 0
const flashStatus = (text: string, duration = 900) => {
  window.clearTimeout(statusTimer)
  setStatus(text)
  statusTimer = window.setTimeout(() => setStatus(''), duration)
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
  const textEl = daemonStatusEl.querySelector<HTMLElement>('.daemonStatus__text')
  if (textEl) {
    textEl.textContent = text
  } else {
    daemonStatusEl.textContent = text
  }
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
    setDaemonStatus('Add token to verify daemon connection', 'warn')
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
      setDaemonStatus(
        `Daemon error (${res.status} ${res.statusText}) — run \`summarize daemon status\``,
        'error'
      )
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
          setDaemonStatus(
            `Daemon ${versionNote} (token mismatch) — update token in side panel and Save`,
            'warn'
          )
          return
        }
      } catch {
        if (checkId !== daemonCheckId) return
        setDaemonStatus(
          `Daemon ${versionNote} (auth failed) — update token in side panel and Save`,
          'warn'
        )
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
    setDaemonStatus(
      'Daemon unreachable — run `summarize daemon status` and check ~/.summarize/logs/daemon.err.log',
      'error'
    )
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

function captureModelSelection() {
  return {
    presetValue: modelPresetEl.value,
    customValue: modelCustomEl.value,
  }
}

function restoreModelSelection(selection: { presetValue: string; customValue: string }) {
  if (selection.presetValue === 'custom') {
    modelPresetEl.value = 'custom'
    modelCustomEl.hidden = false
    modelCustomEl.value = selection.customValue
    return
  }
  const optionValues = new Set(Array.from(modelPresetEl.options).map((o) => o.value))
  if (optionValues.has(selection.presetValue) && selection.presetValue !== 'custom') {
    modelPresetEl.value = selection.presetValue
    modelCustomEl.hidden = true
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

const updateAutoToggle = () => {
  autoToggle.update({
    id: 'options-auto',
    label: 'Auto-summarize when panel is open',
    checked: autoValue,
    onCheckedChange: handleAutoToggleChange,
  })
}
const handleAutoToggleChange = (checked: boolean) => {
  autoValue = checked
  updateAutoToggle()
}
const autoToggle = mountCheckbox(autoToggleRoot, {
  id: 'options-auto',
  label: 'Auto-summarize when panel is open',
  checked: autoValue,
  onCheckedChange: handleAutoToggleChange,
})

const updateChatToggle = () => {
  chatToggle.update({
    id: 'options-chat',
    label: 'Enable Chat mode in the side panel',
    checked: chatEnabledValue,
    onCheckedChange: handleChatToggleChange,
  })
}
const handleChatToggleChange = (checked: boolean) => {
  chatEnabledValue = checked
  updateChatToggle()
}
const chatToggle = mountCheckbox(chatToggleRoot, {
  id: 'options-chat',
  label: 'Enable Chat mode in the side panel',
  checked: chatEnabledValue,
  onCheckedChange: handleChatToggleChange,
})

const updateAutomationToggle = () => {
  automationToggle.update({
    id: 'options-automation',
    label: 'Enable website automation',
    checked: automationEnabledValue,
    onCheckedChange: handleAutomationToggleChange,
  })
}
const handleAutomationToggleChange = (checked: boolean) => {
  automationEnabledValue = checked
  updateAutomationToggle()
  void patchSettings({ automationEnabled: automationEnabledValue })
  void updateAutomationPermissionsUi()
}
const automationToggle = mountCheckbox(automationToggleRoot, {
  id: 'options-automation',
  label: 'Enable website automation',
  checked: automationEnabledValue,
  onCheckedChange: handleAutomationToggleChange,
})

async function updateAutomationPermissionsUi() {
  const status = await getUserScriptsStatus()
  const hasPermission = status.permissionGranted
  const apiAvailable = status.apiAvailable

  automationPermissionsBtn.disabled = !chrome.permissions || (hasPermission && apiAvailable)
  automationPermissionsBtn.textContent = hasPermission
    ? 'Automation permissions granted'
    : 'Enable automation permissions'

  if (!automationEnabledValue) {
    userScriptsNoticeEl.hidden = true
    return
  }

  if (apiAvailable && hasPermission) {
    userScriptsNoticeEl.hidden = true
    return
  }

  const steps = [buildUserScriptsGuidance(status)].filter(Boolean)

  userScriptsNoticeEl.textContent = steps.join(' ')
  userScriptsNoticeEl.hidden = false
}

async function requestAutomationPermissions() {
  if (!chrome.permissions) return
  try {
    const ok = await chrome.permissions.request({
      permissions: ['userScripts'],
    })
    if (!ok) {
      flashStatus('Permission request denied')
    }
  } catch {
    // ignore
  }
  await updateAutomationPermissionsUi()
}

automationPermissionsBtn.addEventListener('click', () => {
  void requestAutomationPermissions()
})

const updateSkillsEmptyState = () => {
  skillsEmptyEl.textContent = skillsSearchQuery
    ? 'No skills match your search.'
    : 'No skills created yet.'
  skillsEmptyEl.hidden = skillsFiltered.length > 0 || importConflicts.length > 0
}

const updateSkillDraft = (patch: Partial<Skill>) => {
  if (!editingSkill) return
  editingSkill = { ...editingSkill, ...patch }
}

const renderSkills = () => {
  skillsListEl.replaceChildren()
  skillsConflictsEl.replaceChildren()

  if (importConflicts.length > 0) {
    skillsConflictsEl.hidden = false
    const title = document.createElement('div')
    title.className = 'skillName'
    title.textContent = 'Import conflicts'
    const hint = document.createElement('div')
    hint.className = 'hint'
    hint.textContent = 'Select which skills should overwrite existing entries.'
    const list = document.createElement('div')
    list.className = 'skillsConflictsList'

    importConflicts.forEach((conflict, index) => {
      const row = document.createElement('label')
      row.className = 'skillsConflictItem'

      const checkbox = document.createElement('input')
      checkbox.type = 'checkbox'
      checkbox.checked = conflict.selected
      checkbox.addEventListener('change', () => {
        importConflicts[index] = { ...conflict, selected: checkbox.checked }
      })

      const content = document.createElement('div')
      content.style.display = 'grid'
      content.style.gap = '2px'

      const name = document.createElement('div')
      name.className = 'skillName'
      name.textContent = conflict.skill.name

      const domains = document.createElement('div')
      domains.className = 'skillDomains'
      domains.textContent = conflict.skill.domainPatterns.join(', ')

      const desc = document.createElement('div')
      desc.className = 'skillDescription'
      desc.textContent = conflict.skill.shortDescription

      content.append(name, domains, desc)
      row.append(checkbox, content)
      list.append(row)
    })

    const actions = document.createElement('div')
    actions.className = 'skillsConflictActions'
    const cancelBtn = document.createElement('button')
    cancelBtn.type = 'button'
    cancelBtn.className = 'miniButton'
    cancelBtn.textContent = 'Cancel'
    cancelBtn.addEventListener('click', () => {
      importConflicts = []
      importedSkills = []
      renderSkills()
    })
    const importBtn = document.createElement('button')
    importBtn.type = 'button'
    importBtn.className = 'miniButton'
    importBtn.textContent = 'Import selected'
    importBtn.addEventListener('click', () => {
      void performImport(importedSkills)
    })
    actions.append(cancelBtn, importBtn)

    skillsConflictsEl.append(title, hint, list, actions)
    updateSkillsEmptyState()
    return
  }

  skillsConflictsEl.hidden = true

  for (const skill of skillsFiltered) {
    if (editingSkill && editingSkill.name === skill.name) {
      const editor = document.createElement('div')
      editor.className = 'skillEditor'

      const heading = document.createElement('div')
      heading.className = 'skillName'
      heading.textContent = `Edit skill: ${editingSkill.name}`

      const nameLabel = document.createElement('label')
      const nameLabelText = document.createElement('span')
      nameLabelText.textContent = 'Name'
      const nameInput = document.createElement('input')
      nameInput.type = 'text'
      nameInput.value = editingSkill.name
      nameInput.disabled = true
      nameLabel.append(nameLabelText, nameInput)

      const domainLabel = document.createElement('label')
      const domainLabelText = document.createElement('span')
      domainLabelText.textContent = 'Domain patterns (comma-separated)'
      const domainInput = document.createElement('input')
      domainInput.type = 'text'
      domainInput.value = editingSkill.domainPatterns.join(', ')
      domainInput.addEventListener('input', () => {
        const patterns = domainInput.value
          .split(',')
          .map((value) => value.trim())
          .filter(Boolean)
        updateSkillDraft({ domainPatterns: patterns })
      })
      domainLabel.append(domainLabelText, domainInput)

      const shortLabel = document.createElement('label')
      const shortText = document.createElement('span')
      shortText.textContent = 'Short description'
      const shortInput = document.createElement('input')
      shortInput.type = 'text'
      shortInput.value = editingSkill.shortDescription
      shortInput.addEventListener('input', () =>
        updateSkillDraft({ shortDescription: shortInput.value })
      )
      shortLabel.append(shortText, shortInput)

      const descriptionLabel = document.createElement('label')
      const descriptionText = document.createElement('span')
      descriptionText.textContent = 'Description (Markdown)'
      const descriptionInput = document.createElement('textarea')
      descriptionInput.rows = 4
      descriptionInput.value = editingSkill.description
      descriptionInput.addEventListener('input', () =>
        updateSkillDraft({ description: descriptionInput.value })
      )
      descriptionLabel.append(descriptionText, descriptionInput)

      const examplesLabel = document.createElement('label')
      const examplesText = document.createElement('span')
      examplesText.textContent = 'Examples (JavaScript)'
      const examplesInput = document.createElement('textarea')
      examplesInput.rows = 4
      examplesInput.value = editingSkill.examples
      examplesInput.addEventListener('input', () =>
        updateSkillDraft({ examples: examplesInput.value })
      )
      examplesLabel.append(examplesText, examplesInput)

      const libraryLabel = document.createElement('label')
      const libraryText = document.createElement('span')
      libraryText.textContent = 'Library code'
      const libraryInput = document.createElement('textarea')
      libraryInput.rows = 8
      libraryInput.value = editingSkill.library
      libraryInput.addEventListener('input', () =>
        updateSkillDraft({ library: libraryInput.value })
      )
      libraryLabel.append(libraryText, libraryInput)

      const actionRow = document.createElement('div')
      actionRow.className = 'skillActions'
      const cancelBtn = document.createElement('button')
      cancelBtn.type = 'button'
      cancelBtn.className = 'miniButton'
      cancelBtn.textContent = 'Cancel'
      cancelBtn.addEventListener('click', () => {
        editingSkill = null
        renderSkills()
      })
      const saveBtn = document.createElement('button')
      saveBtn.type = 'button'
      saveBtn.className = 'miniButton'
      saveBtn.textContent = 'Save'
      saveBtn.addEventListener('click', () => {
        void saveEditingSkill()
      })
      actionRow.append(cancelBtn, saveBtn)

      editor.append(
        heading,
        nameLabel,
        domainLabel,
        shortLabel,
        descriptionLabel,
        examplesLabel,
        libraryLabel,
        actionRow
      )
      skillsListEl.append(editor)
      continue
    }

    const card = document.createElement('div')
    card.className = 'skillCard'

    const header = document.createElement('div')
    header.className = 'skillHeader'

    const name = document.createElement('div')
    name.className = 'skillName'
    name.textContent = skill.name

    const domains = document.createElement('div')
    domains.className = 'skillDomains'
    domains.textContent = skill.domainPatterns.join(', ')

    header.append(name, domains)

    const desc = document.createElement('div')
    desc.className = 'skillDescription'
    desc.textContent = skill.shortDescription

    const actions = document.createElement('div')
    actions.className = 'skillActions'
    const editBtn = document.createElement('button')
    editBtn.type = 'button'
    editBtn.className = 'miniButton'
    editBtn.textContent = 'Edit'
    editBtn.addEventListener('click', () => {
      editingSkill = { ...skill }
      renderSkills()
    })
    const deleteBtn = document.createElement('button')
    deleteBtn.type = 'button'
    deleteBtn.className = 'miniButton'
    deleteBtn.textContent = 'Delete'
    deleteBtn.addEventListener('click', () => {
      void deleteSkillWithPrompt(skill)
    })
    actions.append(editBtn, deleteBtn)

    card.append(header, desc, actions)
    skillsListEl.append(card)
  }

  updateSkillsEmptyState()
}

const filterSkills = () => {
  const query = skillsSearchQuery.toLowerCase()
  skillsFiltered = skillsCache.filter(
    (skill) =>
      skill.name.toLowerCase().includes(query) ||
      skill.shortDescription.toLowerCase().includes(query) ||
      skill.domainPatterns.some((pattern) => pattern.toLowerCase().includes(query))
  )
  renderSkills()
}

const loadSkills = async () => {
  skillsCache = (await listSkills()).sort((a, b) => a.name.localeCompare(b.name))
  filterSkills()
}

const deleteSkillWithPrompt = async (skill: Skill) => {
  if (!confirm(`Delete skill "${skill.name}"?`)) return
  await deleteSkill(skill.name)
  editingSkill = null
  await loadSkills()
}

const saveEditingSkill = async () => {
  if (!editingSkill) return
  const now = new Date().toISOString()
  const toSave: Skill = {
    ...editingSkill,
    createdAt: editingSkill.createdAt || now,
    lastUpdated: now,
  }
  await saveSkill(toSave)
  editingSkill = null
  await loadSkills()
}

const coerceSkill = (raw: unknown): Skill | null => {
  if (!raw || typeof raw !== 'object') return null
  const obj = raw as Record<string, unknown>
  const name = typeof obj.name === 'string' ? obj.name.trim() : ''
  if (!name) return null
  const domainPatterns = Array.isArray(obj.domainPatterns)
    ? obj.domainPatterns.map((pattern) => String(pattern).trim()).filter(Boolean)
    : []
  const createdAt = typeof obj.createdAt === 'string' ? obj.createdAt : new Date().toISOString()
  const lastUpdated = typeof obj.lastUpdated === 'string' ? obj.lastUpdated : createdAt
  return {
    name,
    domainPatterns,
    shortDescription: typeof obj.shortDescription === 'string' ? obj.shortDescription : '',
    description: typeof obj.description === 'string' ? obj.description : '',
    examples: typeof obj.examples === 'string' ? obj.examples : '',
    library: typeof obj.library === 'string' ? obj.library : '',
    createdAt,
    lastUpdated,
  }
}

const exportSkills = async () => {
  const all = await listSkills()
  const json = JSON.stringify(all, null, 2)
  const blob = new Blob([json], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `summarize-skills-${new Date().toISOString().split('T')[0]}.json`
  a.click()
  URL.revokeObjectURL(url)
}

const importSkills = async () => {
  const input = document.createElement('input')
  input.type = 'file'
  input.accept = 'application/json,.json'
  input.addEventListener('change', () => {
    void (async () => {
      const file = input.files?.[0]
      if (!file) return
      try {
        const text = await file.text()
        const parsed = JSON.parse(text)
        if (!Array.isArray(parsed)) {
          setStatus('Invalid skills file: expected an array.')
          return
        }
        const incoming = parsed.map(coerceSkill).filter((skill): skill is Skill => Boolean(skill))
        importedSkills = incoming

        const conflicts: Array<{ skill: Skill; selected: boolean }> = []
        for (const skill of incoming) {
          const existing = await getSkill(skill.name)
          if (existing) conflicts.push({ skill, selected: true })
        }

        if (conflicts.length > 0) {
          importConflicts = conflicts
          renderSkills()
          return
        }

        await performImport(incoming)
      } catch (error) {
        setStatus(
          `Failed to import skills: ${error instanceof Error ? error.message : String(error)}`
        )
      }
    })()
  })
  input.click()
}

const performImport = async (skills: Skill[]) => {
  const skip = new Set(importConflicts.filter((c) => !c.selected).map((c) => c.skill.name))
  const toImport = skills.filter((skill) => !skip.has(skill.name))
  for (const skill of toImport) {
    await saveSkill(skill)
  }
  importConflicts = []
  importedSkills = []
  await loadSkills()
  setStatus(`Imported ${toImport.length} skill(s).`)
  setTimeout(() => setStatus(''), 900)
}

skillsSearchEl.addEventListener('input', () => {
  skillsSearchQuery = skillsSearchEl.value.trim()
  filterSkills()
})

skillsExportBtn.addEventListener('click', () => {
  void exportSkills()
})

skillsImportBtn.addEventListener('click', () => {
  void importSkills()
})

const updateHoverSummariesToggle = () => {
  hoverSummariesToggle.update({
    id: 'options-hover-summaries',
    label: 'Hover summaries (experimental)',
    checked: hoverSummariesValue,
    onCheckedChange: handleHoverSummariesToggleChange,
  })
}
const handleHoverSummariesToggleChange = (checked: boolean) => {
  hoverSummariesValue = checked
  updateHoverSummariesToggle()
}
const hoverSummariesToggle = mountCheckbox(hoverSummariesToggleRoot, {
  id: 'options-hover-summaries',
  label: 'Hover summaries (experimental)',
  checked: hoverSummariesValue,
  onCheckedChange: handleHoverSummariesToggleChange,
})

const updateSummaryTimestampsToggle = () => {
  summaryTimestampsToggle.update({
    id: 'options-summary-timestamps',
    label: 'Summary timestamps (media only)',
    checked: summaryTimestampsValue,
    onCheckedChange: handleSummaryTimestampsToggleChange,
  })
}
const handleSummaryTimestampsToggleChange = (checked: boolean) => {
  summaryTimestampsValue = checked
  updateSummaryTimestampsToggle()
}
const summaryTimestampsToggle = mountCheckbox(summaryTimestampsToggleRoot, {
  id: 'options-summary-timestamps',
  label: 'Summary timestamps (media only)',
  checked: summaryTimestampsValue,
  onCheckedChange: handleSummaryTimestampsToggleChange,
})

const updateExtendedLoggingToggle = () => {
  extendedLoggingToggle.update({
    id: 'options-extended-logging',
    label: 'Extended logging (send full input/output to daemon logs)',
    checked: extendedLoggingValue,
    onCheckedChange: handleExtendedLoggingToggleChange,
  })
}
const handleExtendedLoggingToggleChange = (checked: boolean) => {
  extendedLoggingValue = checked
  updateExtendedLoggingToggle()
}
const extendedLoggingToggle = mountCheckbox(extendedLoggingToggleRoot, {
  id: 'options-extended-logging',
  label: 'Extended logging (send full input/output to daemon logs)',
  checked: extendedLoggingValue,
  onCheckedChange: handleExtendedLoggingToggleChange,
})

const updateAdvancedVisibility = () => {
  advancedFieldsEl.hidden = !advancedOpen
  advancedToggleEl.setAttribute('aria-expanded', advancedOpen ? 'true' : 'false')
}

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
  hoverPromptEl.value = s.hoverPrompt || defaultSettings.hoverPrompt
  autoValue = s.autoSummarize
  chatEnabledValue = s.chatEnabled
  automationEnabledValue = s.automationEnabled
  hoverSummariesValue = s.hoverSummaries
  summaryTimestampsValue = s.summaryTimestamps
  extendedLoggingValue = s.extendedLogging
  updateAutoToggle()
  updateChatToggle()
  updateAutomationToggle()
  updateHoverSummariesToggle()
  updateSummaryTimestampsToggle()
  updateExtendedLoggingToggle()
  maxCharsEl.value = String(s.maxChars)
  requestModeEl.value = s.requestMode
  firecrawlModeEl.value = s.firecrawlMode
  markdownModeEl.value = s.markdownMode
  preprocessModeEl.value = s.preprocessMode
  youtubeModeEl.value = s.youtubeMode
  transcriberEl.value = s.transcriber
  timeoutEl.value = s.timeout
  retriesEl.value = typeof s.retries === 'number' ? String(s.retries) : ''
  maxOutputTokensEl.value = s.maxOutputTokens
  fontFamilyEl.value = s.fontFamily
  fontSizeEl.value = String(s.fontSize)
  currentScheme = s.colorScheme
  currentMode = s.colorMode
  pickers.update({ scheme: currentScheme, mode: currentMode, ...pickerHandlers })
  applyTheme({ scheme: s.colorScheme, mode: s.colorMode })
  updateAdvancedVisibility()
  await loadSkills()
  await updateAutomationPermissionsUi()
}

let refreshTimer = 0
tokenEl.addEventListener('input', () => {
  window.clearTimeout(refreshTimer)
  refreshTimer = window.setTimeout(() => {
    void refreshModelPresets(tokenEl.value)
    void checkDaemonStatus(tokenEl.value)
  }, 350)
})

const copyToken = async () => {
  const token = tokenEl.value.trim()
  if (!token) {
    flashStatus('Token empty')
    return
  }
  try {
    await navigator.clipboard.writeText(token)
    flashStatus('Token copied')
    return
  } catch {
    // fallback
  }
  tokenEl.focus()
  tokenEl.select()
  tokenEl.setSelectionRange(0, token.length)
  const ok = document.execCommand('copy')
  flashStatus(ok ? 'Token copied' : 'Copy failed')
}

tokenCopyBtn.addEventListener('click', () => {
  void copyToken()
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

advancedToggleEl.addEventListener('click', () => {
  advancedOpen = !advancedOpen
  updateAdvancedVisibility()
})

hoverPromptResetBtn.addEventListener('click', () => {
  hoverPromptEl.value = defaultSettings.hoverPrompt
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
      hoverPrompt: hoverPromptEl.value || defaultSettings.hoverPrompt,
      autoSummarize: autoValue,
      hoverSummaries: hoverSummariesValue,
      chatEnabled: chatEnabledValue,
      automationEnabled: automationEnabledValue,
      summaryTimestamps: summaryTimestampsValue,
      extendedLogging: extendedLoggingValue,
      maxChars: Number(maxCharsEl.value) || defaultSettings.maxChars,
      requestMode: requestModeEl.value || defaultSettings.requestMode,
      firecrawlMode: firecrawlModeEl.value || defaultSettings.firecrawlMode,
      markdownMode: markdownModeEl.value || defaultSettings.markdownMode,
      preprocessMode: preprocessModeEl.value || defaultSettings.preprocessMode,
      youtubeMode: youtubeModeEl.value || defaultSettings.youtubeMode,
      transcriber: transcriberEl.value || defaultSettings.transcriber,
      timeout: timeoutEl.value || defaultSettings.timeout,
      retries: (() => {
        const raw = retriesEl.value.trim()
        if (!raw) return defaultSettings.retries
        const parsed = Number(raw)
        return Number.isFinite(parsed) ? parsed : defaultSettings.retries
      })(),
      maxOutputTokens: maxOutputTokensEl.value || defaultSettings.maxOutputTokens,
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
