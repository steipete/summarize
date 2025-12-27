import { defineBackground } from 'wxt/utils/define-background'

import { buildDaemonRequestBody } from '../lib/daemon-payload'
import { loadSettings, patchSettings } from '../lib/settings'

type PanelToBg =
  | { type: 'panel:ready' }
  | { type: 'panel:summarize' }
  | { type: 'panel:ping' }
  | { type: 'panel:closed' }
  | { type: 'panel:rememberUrl'; url: string }
  | { type: 'panel:setAuto'; value: boolean }
  | { type: 'panel:setLength'; value: string }
  | { type: 'panel:openOptions' }

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

type UiState = {
  panelOpen: boolean
  daemon: { ok: boolean; authed: boolean; error?: string }
  tab: { url: string | null; title: string | null }
  settings: { autoSummarize: boolean; model: string; length: string; tokenPresent: boolean }
  status: string
}

type ExtractRequest = { type: 'extract'; maxChars: number }
type ExtractResponse =
  | { ok: true; url: string; title: string | null; text: string; truncated: boolean }
  | { ok: false; error: string }

function canSummarizeUrl(url: string | undefined): url is string {
  if (!url) return false
  if (url.startsWith('chrome://')) return false
  if (url.startsWith('chrome-extension://')) return false
  if (url.startsWith('edge://')) return false
  if (url.startsWith('about:')) return false
  return true
}

async function getActiveTab(): Promise<chrome.tabs.Tab | null> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  return tab ?? null
}

async function daemonHealth(): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch('http://127.0.0.1:8787/health')
    if (!res.ok) return { ok: false, error: `${res.status} ${res.statusText}` }
    return { ok: true }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'health failed'
    if (message.toLowerCase() === 'failed to fetch') {
      return {
        ok: false,
        error:
          'Failed to fetch (daemon unreachable or blocked by Chrome; try `summarize daemon status` and check ~/.summarize/logs/daemon.err.log)',
      }
    }
    return { ok: false, error: message }
  }
}

async function daemonPing(token: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch('http://127.0.0.1:8787/v1/ping', {
      headers: { Authorization: `Bearer ${token}` },
    })
    if (!res.ok) return { ok: false, error: `${res.status} ${res.statusText}` }
    return { ok: true }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'ping failed'
    if (message.toLowerCase() === 'failed to fetch') {
      return {
        ok: false,
        error:
          'Failed to fetch (daemon unreachable or blocked by Chrome; try `summarize daemon status`)',
      }
    }
    return { ok: false, error: message }
  }
}

function friendlyFetchError(err: unknown, context: string): string {
  const message = err instanceof Error ? err.message : String(err)
  if (message.toLowerCase() === 'failed to fetch') {
    return `${context}: Failed to fetch (daemon unreachable or blocked by Chrome; try \`summarize daemon status\` and check ~/.summarize/logs/daemon.err.log)`
  }
  return `${context}: ${message}`
}

async function extractFromTab(
  tabId: number,
  maxChars: number
): Promise<{ ok: true; data: ExtractResponse & { ok: true } } | { ok: false; error: string }> {
  const req = { type: 'extract', maxChars } satisfies ExtractRequest

  const tryInject = async (): Promise<{ ok: true } | { ok: false; error: string }> => {
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ['content-scripts/extract.js'],
      })
      return { ok: true }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return {
        ok: false,
        error:
          message.toLowerCase().includes('cannot access') ||
          message.toLowerCase().includes('denied')
            ? `Chrome blocked content access (${message}). Check extension “Site access” → “On all sites” (or allow this domain), then reload the tab.`
            : `Failed to inject content script (${message}). Check extension “Site access”, then reload the tab.`,
      }
    }
  }

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = (await chrome.tabs.sendMessage(tabId, req)) as ExtractResponse
      if (!res.ok) return { ok: false, error: res.error }
      return { ok: true, data: res }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      const noReceiver =
        message.includes('Receiving end does not exist') ||
        message.includes('Could not establish connection')
      if (noReceiver) {
        const injected = await tryInject()
        if (!injected.ok) return injected
        await new Promise((r) => setTimeout(r, 120))
        continue
      }

      if (attempt === 2) {
        return {
          ok: false,
          error: noReceiver
            ? 'Content script not ready. Check extension “Site access” → “On all sites”, then reload the tab.'
            : message,
        }
      }
      await new Promise((r) => setTimeout(r, 350))
    }
  }

  return { ok: false, error: 'Content script not ready' }
}

export default defineBackground(() => {
  let panelOpen = false
  let panelLastPingAt = 0
  let lastSummarizedUrl: string | null = null
  let inflightUrl: string | null = null
  let runController: AbortController | null = null
  let lastNavAt = 0

  const isPanelOpen = () => {
    if (!panelOpen) return false
    if (panelLastPingAt === 0) return true
    return Date.now() - panelLastPingAt < 45_000
  }

  const send = async (msg: BgToPanel) => {
    if (!isPanelOpen()) return
    try {
      await chrome.runtime.sendMessage(msg)
    } catch {
      // ignore (panel closed / reloading)
    }
  }
  const sendStatus = (status: string) => void send({ type: 'ui:status', status })

  const emitState = async (status: string) => {
    const settings = await loadSettings()
    const tab = await getActiveTab()
    const health = await daemonHealth()
    const authed = settings.token.trim() ? await daemonPing(settings.token.trim()) : { ok: false }
    const state: UiState = {
      panelOpen: isPanelOpen(),
      daemon: { ok: health.ok, authed: authed.ok, error: health.error ?? authed.error },
      tab: { url: tab?.url ?? null, title: tab?.title ?? null },
      settings: {
        autoSummarize: settings.autoSummarize,
        model: settings.model,
        length: settings.length,
        tokenPresent: Boolean(settings.token.trim()),
      },
      status,
    }
    void send({ type: 'ui:state', state })
  }

  const summarizeActiveTab = async (reason: string) => {
    if (!isPanelOpen()) return

    const settings = await loadSettings()
    if (reason !== 'manual' && !settings.autoSummarize) return
    if (!settings.token.trim()) {
      await emitState('Setup required (missing token)')
      return
    }

    const tab = await getActiveTab()
    if (!tab?.id || !canSummarizeUrl(tab.url)) return

    runController?.abort()
    runController = new AbortController()

    sendStatus(`Extracting… (${reason})`)
    const extractedAttempt = await extractFromTab(tab.id, settings.maxChars)
    const extracted = extractedAttempt.ok
      ? extractedAttempt.data
      : {
          ok: true,
          url: tab.url,
          title: tab.title ?? null,
          text: '',
          truncated: false,
        }

    if (!extracted) return

    if (
      settings.autoSummarize &&
      (lastSummarizedUrl === extracted.url || inflightUrl === extracted.url) &&
      reason !== 'manual'
    ) {
      sendStatus('')
      return
    }

    sendStatus('Requesting daemon…')
    inflightUrl = extracted.url
    let id: string
    try {
      const res = await fetch('http://127.0.0.1:8787/v1/summarize', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${settings.token.trim()}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          ...buildDaemonRequestBody({ extracted, settings }),
        }),
        signal: runController.signal,
      })
      const json = (await res.json()) as { ok: boolean; id?: string; error?: string }
      if (!res.ok || !json.ok || !json.id) {
        throw new Error(json.error || `${res.status} ${res.statusText}`)
      }
      id = json.id
    } catch (err) {
      if (runController.signal.aborted) return
      const message = friendlyFetchError(err, 'Daemon request failed')
      void send({ type: 'run:error', message })
      sendStatus(`Error: ${message}`)
      inflightUrl = null
      return
    }

    void send({
      type: 'run:start',
      run: { id, url: extracted.url, title: extracted.title, model: settings.model, reason },
    })
  }

  chrome.runtime.onMessage.addListener((msg: PanelToBg, _sender, sendResponse) => {
    if (!msg || typeof msg !== 'object' || typeof (msg as { type?: unknown }).type !== 'string') {
      return
    }
    const type = (msg as PanelToBg).type
    if (!type.startsWith('panel:')) return

    panelOpen = true
    if (type === 'panel:ping') panelLastPingAt = Date.now()

    switch (type) {
      case 'panel:ready':
        panelLastPingAt = Date.now()
        void emitState('')
        void summarizeActiveTab('panel-open')
        break
      case 'panel:closed':
        panelOpen = false
        panelLastPingAt = 0
        runController?.abort()
        runController = null
        inflightUrl = null
        break
      case 'panel:summarize':
        void summarizeActiveTab('manual')
        break
      case 'panel:ping':
        break
      case 'panel:rememberUrl':
        lastSummarizedUrl = (msg as { url: string }).url
        inflightUrl = null
        break
      case 'panel:setAuto':
        void (async () => {
          await patchSettings({ autoSummarize: (msg as { value: boolean }).value })
          void emitState('')
          if ((msg as { value: boolean }).value) void summarizeActiveTab('auto-enabled')
        })()
        break
      case 'panel:setLength':
        void (async () => {
          await patchSettings({ length: (msg as { value: string }).value })
          void emitState('')
        })()
        break
      case 'panel:openOptions':
        void chrome.runtime.openOptionsPage()
        break
    }

    try {
      sendResponse({ ok: true })
    } catch {
      // ignore
    }
    // keep SW alive for async branches
    return true
  })

  chrome.webNavigation.onHistoryStateUpdated.addListener(() => {
    const now = Date.now()
    if (now - lastNavAt < 700) return
    lastNavAt = now
    void emitState('')
    void summarizeActiveTab('spa-nav')
  })

  chrome.tabs.onActivated.addListener(() => {
    void emitState('')
    void summarizeActiveTab('tab-activated')
  })

  chrome.tabs.onUpdated.addListener((_tabId, changeInfo) => {
    if (changeInfo.status === 'complete') {
      void emitState('')
      void summarizeActiveTab('tab-updated')
    }
  })

  void chrome.sidePanel?.setPanelBehavior?.({ openPanelOnActionClick: true })
})
