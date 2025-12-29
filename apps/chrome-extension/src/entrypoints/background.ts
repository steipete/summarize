import { defineBackground } from 'wxt/utils/define-background'

import { buildDaemonRequestBody } from '../lib/daemon-payload'
import { loadSettings, patchSettings } from '../lib/settings'

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

type RunStart = {
  id: string
  url: string
  title: string | null
  model: string
  reason: string
}

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

const optionsWindowSize = { width: 940, height: 680 }
const optionsWindowMin = { width: 820, height: 560 }
const optionsWindowMargin = 20

function resolveOptionsUrl(): string {
  const page = chrome.runtime.getManifest().options_ui?.page ?? 'options.html'
  return chrome.runtime.getURL(page)
}

async function openOptionsWindow() {
  const url = resolveOptionsUrl()
  try {
    if (chrome.windows?.create) {
      const current = await chrome.windows.getCurrent()
      const maxWidth = current.width
        ? Math.max(optionsWindowMin.width, current.width - optionsWindowMargin)
        : null
      const maxHeight = current.height
        ? Math.max(optionsWindowMin.height, current.height - optionsWindowMargin)
        : null
      const width = maxWidth ? Math.min(optionsWindowSize.width, maxWidth) : optionsWindowSize.width
      const height = maxHeight
        ? Math.min(optionsWindowSize.height, maxHeight)
        : optionsWindowSize.height
      await chrome.windows.create({ url, type: 'popup', width, height })
      return
    }
  } catch {
    // ignore and fall back
  }
  void chrome.runtime.openOptionsPage()
}

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

  // Chat state
  let cachedExtract: { url: string; title: string | null; text: string } | null = null

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

  const summarizeActiveTab = async (reason: string, opts?: { refresh?: boolean }) => {
    if (!isPanelOpen()) return

    const settings = await loadSettings()
    const isManual = reason === 'manual' || reason === 'refresh' || reason === 'length-change'
    if (!isManual && !settings.autoSummarize) return
    if (!settings.token.trim()) {
      await emitState('Setup required (missing token)')
      return
    }

    if (reason === 'spa-nav' || reason === 'tab-url-change') {
      await new Promise((resolve) => setTimeout(resolve, 220))
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
      !isManual
    ) {
      sendStatus('')
      return
    }

    const resolvedTitle = tab.title?.trim() || extracted.title || null
    const resolvedExtracted = { ...extracted, title: resolvedTitle }

    // Cache for chat reuse
    cachedExtract = {
      url: extracted.url,
      title: resolvedTitle,
      text: extracted.text,
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
        body: JSON.stringify(
          buildDaemonRequestBody({
            extracted: resolvedExtracted,
            settings,
            noCache: Boolean(opts?.refresh),
          })
        ),
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
      run: { id, url: extracted.url, title: resolvedTitle, model: settings.model, reason },
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
        lastSummarizedUrl = null
        inflightUrl = null
        runController?.abort()
        runController = null
        void emitState('')
        void summarizeActiveTab('panel-open')
        break
      case 'panel:closed':
        panelOpen = false
        panelLastPingAt = 0
        runController?.abort()
        runController = null
        lastSummarizedUrl = null
        inflightUrl = null
        break
      case 'panel:summarize':
        void summarizeActiveTab((msg as { refresh?: boolean }).refresh ? 'refresh' : 'manual', {
          refresh: Boolean((msg as { refresh?: boolean }).refresh),
        })
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
          const next = (msg as { value: string }).value
          const current = await loadSettings()
          if (current.length === next) return
          await patchSettings({ length: next })
          void emitState('')
          void summarizeActiveTab('length-change')
        })()
        break
      case 'panel:openOptions':
        void openOptionsWindow()
        break
      case 'panel:startChat':
        void (async () => {
          const settings = await loadSettings()
          if (!settings.token.trim()) {
            void send({ type: 'run:error', message: 'Setup required (missing token)' })
            return
          }

          const tab = await getActiveTab()
          if (!tab?.id || !canSummarizeUrl(tab.url)) {
            void send({ type: 'run:error', message: 'Cannot chat on this page' })
            return
          }

          // Check if we have cached content for this URL
          if (cachedExtract && cachedExtract.url === tab.url) {
            void send({
              type: 'chat:ready',
              payload: {
                url: cachedExtract.url,
                title: cachedExtract.title,
                transcript: cachedExtract.text,
              },
            })
            sendStatus('')
            return
          }

          // Use daemon extraction (same pipeline as summarize)
          sendStatus('Extracting page content…')
          try {
            const res = await fetch('http://127.0.0.1:8787/v1/summarize', {
              method: 'POST',
              headers: {
                Authorization: `Bearer ${settings.token.trim()}`,
                'content-type': 'application/json',
              },
              body: JSON.stringify({
                url: tab.url,
                mode: 'url',
                extractOnly: true,
                maxCharacters: settings.maxChars,
              }),
            })
            const json = (await res.json()) as {
              ok: boolean
              extracted?: {
                content: string
                title: string | null
                url: string
                wordCount: number
                totalCharacters: number
                truncated: boolean
                transcriptSource: string | null
              }
              error?: string
            }
            if (!res.ok || !json.ok || !json.extracted) {
              throw new Error(json.error || `${res.status} ${res.statusText}`)
            }

            // Cache the extracted content
            cachedExtract = {
              url: json.extracted.url,
              title: json.extracted.title,
              text: json.extracted.content,
            }

            void send({
              type: 'chat:ready',
              payload: {
                url: json.extracted.url,
                title: json.extracted.title,
                transcript: json.extracted.content,
              },
            })
            sendStatus('')
          } catch (err) {
            const message = friendlyFetchError(err, 'Extraction failed')
            void send({ type: 'run:error', message })
            sendStatus(`Error: ${message}`)
          }
        })()
        break
      case 'panel:chat':
        void (async () => {
          const settings = await loadSettings()
          if (!settings.token.trim()) {
            void send({ type: 'run:error', message: 'Setup required (missing token)' })
            return
          }

          if (!cachedExtract) {
            void send({ type: 'run:error', message: 'No page content available' })
            return
          }

          const chatMessages = (msg as { messages: Array<{ role: 'user' | 'assistant'; content: string }> }).messages

          sendStatus('Sending to AI…')

          try {
            const res = await fetch('http://127.0.0.1:8787/v1/chat', {
              method: 'POST',
              headers: {
                Authorization: `Bearer ${settings.token.trim()}`,
                'content-type': 'application/json',
              },
              body: JSON.stringify({
                url: cachedExtract.url,
                title: cachedExtract.title,
                pageContent: cachedExtract.text,
                messages: chatMessages,
                model: settings.model,
              }),
            })
            const json = (await res.json()) as { ok: boolean; id?: string; error?: string }
            if (!res.ok || !json.ok || !json.id) {
              throw new Error(json.error || `${res.status} ${res.statusText}`)
            }

            void send({
              type: 'chat:start',
              payload: { id: json.id, url: cachedExtract.url },
            })
            sendStatus('')
          } catch (err) {
            const message = friendlyFetchError(err, 'Chat request failed')
            void send({ type: 'run:error', message })
            sendStatus(`Error: ${message}`)
          }
        })()
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
    if (typeof changeInfo.title === 'string' || typeof changeInfo.url === 'string') {
      void emitState('')
    }
    if (typeof changeInfo.url === 'string') {
      void summarizeActiveTab('tab-url-change')
    }
    if (changeInfo.status === 'complete') {
      void emitState('')
      void summarizeActiveTab('tab-updated')
    }
  })

  void chrome.sidePanel?.setPanelBehavior?.({ openPanelOnActionClick: true })
})
