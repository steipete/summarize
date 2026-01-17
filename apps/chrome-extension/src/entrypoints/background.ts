import type { AssistantMessage, Message } from '@mariozechner/pi-ai'
import { shouldPreferUrlMode } from '@steipete/summarize-core/content/url'
import { defineBackground } from 'wxt/utils/define-background'
import { parseSseEvent, type SseSlidesData } from '../../../../src/shared/sse-events.js'
import {
  deleteArtifact,
  getArtifactRecord,
  listArtifacts,
  parseArtifact,
  upsertArtifact,
} from '../automation/artifacts-store'
import { readAgentResponse } from '../lib/agent-response'
import { buildChatPageContent } from '../lib/chat-context'
import { buildDaemonRequestBody, buildSummarizeRequestBody } from '../lib/daemon-payload'
import { createDaemonRecovery, isDaemonUnreachableError } from '../lib/daemon-recovery'
import { loadSettings, patchSettings } from '../lib/settings'
import { parseSseStream } from '../lib/sse'

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
  | { type: 'agent:chunk'; requestId: string; text: string }
  | { type: 'chat:history'; requestId: string; ok: boolean; messages?: Message[]; error?: string }
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

type HoverToBg =
  | {
      type: 'hover:summarize'
      requestId: string
      url: string
      title: string | null
      token?: string
    }
  | { type: 'hover:abort'; requestId: string }

type BgToHover =
  | { type: 'hover:chunk'; requestId: string; url: string; text: string }
  | { type: 'hover:done'; requestId: string; url: string }
  | { type: 'hover:error'; requestId: string; url: string; message: string }

type NativeInputRequest = {
  type: 'automation:native-input'
  payload: {
    action: 'click' | 'type' | 'press' | 'keydown' | 'keyup'
    x?: number
    y?: number
    text?: string
    key?: string
  }
}

type NativeInputResponse = { ok: true } | { ok: false; error: string }
type ArtifactsRequest = {
  type: 'automation:artifacts'
  requestId: string
  action?: string
  payload?: unknown
}

type UiState = {
  panelOpen: boolean
  daemon: { ok: boolean; authed: boolean; error?: string }
  tab: { id: number | null; url: string | null; title: string | null }
  media: { hasVideo: boolean; hasAudio: boolean; hasCaptions: boolean } | null
  stats: { pageWords: number | null; videoDurationSeconds: number | null }
  settings: {
    autoSummarize: boolean
    hoverSummaries: boolean
    chatEnabled: boolean
    automationEnabled: boolean
    slidesEnabled: boolean
    slidesLayout: 'strip' | 'gallery'
    fontSize: number
    lineHeight: number
    model: string
    length: string
    tokenPresent: boolean
  }
  status: string
}

type ExtractRequest = { type: 'extract'; maxChars: number }
type SeekRequest = { type: 'seek'; seconds: number }
type ExtractResponse =
  | {
      ok: true
      url: string
      title: string | null
      text: string
      truncated: boolean
      mediaDurationSeconds?: number | null
      media?: { hasVideo: boolean; hasAudio: boolean; hasCaptions: boolean }
    }
  | { ok: false; error: string }
type SeekResponse = { ok: true } | { ok: false; error: string }

type SlidesPayload = {
  sourceUrl: string
  sourceId: string
  sourceKind: string
  ocrAvailable: boolean
  slides: Array<{
    index: number
    timestamp: number
    ocrText?: string | null
    ocrConfidence?: number | null
  }>
}

type PanelCachePayload = {
  tabId: number
  url: string
  title: string | null
  summaryMarkdown: string | null
  summaryFromCache: boolean | null
  lastMeta: { inputSummary: string | null; model: string | null; modelLabel: string | null }
  slides: SseSlidesData | null
  transcriptTimedText: string | null
}

type PanelSession = {
  windowId: number
  port: chrome.runtime.Port
  panelOpen: boolean
  panelLastPingAt: number
  lastSummarizedUrl: string | null
  inflightUrl: string | null
  runController: AbortController | null
  agentController: AbortController | null
  lastNavAt: number
  daemonRecovery: ReturnType<typeof createDaemonRecovery>
}

const optionsWindowSize = { width: 940, height: 680 }
const optionsWindowMin = { width: 820, height: 560 }
const optionsWindowMargin = 20
const MIN_CHAT_CHARS = 100
const CHAT_FULL_TRANSCRIPT_MAX_CHARS = Number.MAX_SAFE_INTEGER
const MAX_SLIDE_OCR_CHARS = 8000

const formatSlideTimestamp = (seconds: number): string => {
  const safe = Math.max(0, Math.floor(seconds))
  const h = Math.floor(safe / 3600)
  const m = Math.floor((safe % 3600) / 60)
  const s = safe % 60
  const mm = m.toString().padStart(2, '0')
  const ss = s.toString().padStart(2, '0')
  return h > 0 ? `${h}:${mm}:${ss}` : `${m}:${ss}`
}

const buildSlidesText = (slides: SlidesPayload | null): { count: number; text: string } | null => {
  if (!slides || slides.slides.length === 0) return null
  let remaining = MAX_SLIDE_OCR_CHARS
  const lines: string[] = []
  for (const slide of slides.slides) {
    const text = slide.ocrText?.trim()
    if (!text) continue
    const timestamp = Number.isFinite(slide.timestamp)
      ? formatSlideTimestamp(slide.timestamp)
      : null
    const label = timestamp ? `@ ${timestamp}` : ''
    const entry = `Slide ${slide.index} ${label}:\n${text}`.trim()
    if (entry.length > remaining && lines.length > 0) break
    lines.push(entry)
    remaining -= entry.length
    if (remaining <= 0) break
  }
  return lines.length > 0 ? { count: slides.slides.length, text: lines.join('\n\n') } : null
}

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
  if (url.startsWith('moz-extension://')) return false // Firefox extension pages
  if (url.startsWith('edge://')) return false
  if (url.startsWith('about:')) return false
  return true
}

async function getActiveTab(windowId?: number): Promise<chrome.tabs.Tab | null> {
  const [tab] = await chrome.tabs.query(
    typeof windowId === 'number'
      ? { active: true, windowId }
      : { active: true, currentWindow: true }
  )
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

function isYouTubeWatchUrl(value: string | null | undefined): boolean {
  if (!value) return false
  try {
    const url = new URL(value)
    const host = url.hostname.toLowerCase()
    if (host === 'youtu.be') {
      const id = url.pathname.replace(/^\/+/, '').trim()
      return Boolean(id)
    }
    if (!host.endsWith('youtube.com')) return false
    const path = url.pathname.toLowerCase()
    if (path === '/watch') return Boolean(url.searchParams.get('v')?.trim())
    if (path.startsWith('/shorts/')) return true
    if (path.startsWith('/live/')) return true
    return false
  } catch {
    return false
  }
}

async function extractFromTab(
  tabId: number,
  maxChars: number,
  opts?: {
    timeoutMs?: number
    log?: (event: string, detail?: Record<string, unknown>) => void
  }
): Promise<{ ok: true; data: ExtractResponse & { ok: true } } | { ok: false; error: string }> {
  const req = { type: 'extract', maxChars } satisfies ExtractRequest
  const timeoutMs = opts?.timeoutMs ?? 6_000

  const sendMessageWithTimeout = async (): Promise<ExtractResponse> => {
    const start = Date.now()
    let timer: ReturnType<typeof setTimeout> | null = null
    try {
      const res = (await Promise.race([
        chrome.tabs.sendMessage(tabId, req) as Promise<ExtractResponse>,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error(`extract timed out after ${timeoutMs}ms`)),
            timeoutMs
          )
        }),
      ])) as ExtractResponse
      if (timer) clearTimeout(timer)
      opts?.log?.('extract:message:ok', { elapsedMs: Date.now() - start })
      return res
    } catch (err) {
      if (timer) clearTimeout(timer)
      opts?.log?.('extract:message:error', {
        elapsedMs: Date.now() - start,
        error: err instanceof Error ? err.message : String(err),
      })
      throw err
    }
  }

  const tryInject = async (): Promise<{ ok: true } | { ok: false; error: string }> => {
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ['content-scripts/extract.js'],
      })
      opts?.log?.('extract:inject:ok')
      return { ok: true }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      opts?.log?.('extract:inject:error', { error: message })
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
      opts?.log?.('extract:attempt', { attempt: attempt + 1, timeoutMs })
      const res = await sendMessageWithTimeout()
      if (!res.ok) return { ok: false, error: res.error }
      return { ok: true, data: res }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      const noReceiver =
        message.includes('Receiving end does not exist') ||
        message.includes('Could not establish connection')
      const didTimeout = message.includes('extract timed out')
      if (noReceiver) {
        const injected = await tryInject()
        if (!injected.ok) return injected
        await new Promise((r) => setTimeout(r, 120))
        continue
      }

      if (didTimeout) {
        if (attempt === 2) {
          return {
            ok: false,
            error:
              'Page extraction timed out. Reload the tab (or “Summarize → Refresh”), then retry.',
          }
        }
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

async function seekInTab(
  tabId: number,
  seconds: number
): Promise<{ ok: true } | { ok: false; error: string }> {
  const req = { type: 'seek', seconds } satisfies SeekRequest

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
      const res = (await chrome.tabs.sendMessage(tabId, req)) as SeekResponse
      if (!res.ok) return { ok: false, error: res.error }
      return { ok: true }
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

function resolveKeyCode(key: string): { code: string; keyCode: number; text?: string } {
  const named: Record<string, number> = {
    Enter: 13,
    Tab: 9,
    Backspace: 8,
    Escape: 27,
    ArrowLeft: 37,
    ArrowUp: 38,
    ArrowRight: 39,
    ArrowDown: 40,
    Delete: 46,
    Home: 36,
    End: 35,
    PageUp: 33,
    PageDown: 34,
    Space: 32,
  }
  if (named[key]) {
    return { code: key, keyCode: named[key] }
  }
  if (key.length === 1) {
    const upper = key.toUpperCase()
    return { code: upper, keyCode: upper.charCodeAt(0), text: key }
  }
  return { code: key, keyCode: 0 }
}

async function dispatchNativeInput(
  tabId: number,
  payload: NativeInputRequest['payload']
): Promise<NativeInputResponse> {
  const hasPermission = await chrome.permissions.contains({ permissions: ['debugger'] })
  if (!hasPermission) {
    return { ok: false, error: 'Debugger permission not granted.' }
  }

  try {
    await chrome.debugger.attach({ tabId }, '1.3')
  } catch (err) {
    if (!(err instanceof Error) || !err.message.includes('already attached')) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  const send = (method: string, params: Record<string, unknown>) =>
    chrome.debugger.sendCommand({ tabId }, method, params)

  try {
    switch (payload.action) {
      case 'click': {
        const x = payload.x ?? 0
        const y = payload.y ?? 0
        await send('Input.dispatchMouseEvent', {
          type: 'mousePressed',
          button: 'left',
          clickCount: 1,
          x,
          y,
        })
        await send('Input.dispatchMouseEvent', {
          type: 'mouseReleased',
          button: 'left',
          clickCount: 1,
          x,
          y,
        })
        return { ok: true }
      }
      case 'type': {
        const text = payload.text ?? ''
        if (!text) return { ok: false, error: 'Missing text' }
        await send('Input.insertText', { text })
        return { ok: true }
      }
      case 'press':
      case 'keydown':
      case 'keyup': {
        const key = payload.key ?? ''
        if (!key) return { ok: false, error: 'Missing key' }
        const { code, keyCode, text } = resolveKeyCode(key)
        const sendKey = async (type: string) =>
          send('Input.dispatchKeyEvent', {
            type,
            key,
            code,
            text,
            windowsVirtualKeyCode: keyCode,
            nativeVirtualKeyCode: keyCode,
          })
        if (payload.action === 'press') {
          await sendKey('keyDown')
          await sendKey('keyUp')
          return { ok: true }
        }
        await sendKey(payload.action === 'keydown' ? 'keyDown' : 'keyUp')
        return { ok: true }
      }
      default:
        return { ok: false, error: 'Unknown action' }
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  } finally {
    try {
      await chrome.debugger.detach({ tabId })
    } catch {
      // ignore
    }
  }
}

export default defineBackground(() => {
  const panelSessions = new Map<number, PanelSession>()
  const lastMediaProbeByTab = new Map<number, string>()
  type CachedExtract = {
    url: string
    title: string | null
    text: string
    source: 'page' | 'url'
    truncated: boolean
    totalCharacters: number
    wordCount: number | null
    media: { hasVideo: boolean; hasAudio: boolean; hasCaptions: boolean } | null
    transcriptSource: string | null
    transcriptionProvider: string | null
    transcriptCharacters: number | null
    transcriptWordCount: number | null
    transcriptLines: number | null
    transcriptTimedText: string | null
    mediaDurationSeconds: number | null
    slides: SlidesPayload | null
    diagnostics?: {
      strategy: string
      markdown?: { used?: boolean; provider?: string | null } | null
      firecrawl?: { used?: boolean } | null
      transcript?: {
        provider?: string | null
        cacheStatus?: string | null
        attemptedProviders?: string[] | null
      } | null
    } | null
  }
  const cachedExtracts = new Map<number, CachedExtract>()
  const panelCacheByTabId = new Map<number, PanelCachePayload>()
  const hoverControllersByTabId = new Map<
    number,
    { requestId: string; controller: AbortController }
  >()

  const isPanelOpen = (session: PanelSession) => {
    if (!session.panelOpen) return false
    if (session.panelLastPingAt === 0) return true
    return Date.now() - session.panelLastPingAt < 45_000
  }

  const getPanelSession = (windowId: number) => panelSessions.get(windowId) ?? null

  const getPanelPortMap = () => {
    const global = globalThis as typeof globalThis & {
      __summarizePanelPorts?: Map<number, chrome.runtime.Port>
    }
    if (!global.__summarizePanelPorts) {
      global.__summarizePanelPorts = new Map()
    }
    return global.__summarizePanelPorts
  }

  const registerPanelSession = (windowId: number, port: chrome.runtime.Port) => {
    const existing = panelSessions.get(windowId)
    if (existing && existing.port !== port) {
      existing.runController?.abort()
      existing.agentController?.abort()
    }
    const session: PanelSession = existing ?? {
      windowId,
      port,
      panelOpen: false,
      panelLastPingAt: 0,
      lastSummarizedUrl: null,
      inflightUrl: null,
      runController: null,
      agentController: null,
      lastNavAt: 0,
      daemonRecovery: createDaemonRecovery(),
    }
    session.port = port
    panelSessions.set(windowId, session)
    getPanelPortMap().set(windowId, port)
    return session
  }

  const clearCachedExtractsForWindow = async (windowId: number) => {
    try {
      const tabs = await chrome.tabs.query({ windowId })
      for (const tab of tabs) {
        if (!tab.id) continue
        cachedExtracts.delete(tab.id)
        lastMediaProbeByTab.delete(tab.id)
      }
    } catch {
      // ignore
    }
  }

  const getCachedExtract = (tabId: number, url?: string | null) => {
    const cached = cachedExtracts.get(tabId) ?? null
    if (!cached) return null
    if (url && cached.url !== url) {
      cachedExtracts.delete(tabId)
      return null
    }
    return cached
  }

  const storePanelCache = (payload: PanelCachePayload) => {
    panelCacheByTabId.set(payload.tabId, payload)
  }

  const getPanelCache = (tabId: number, url?: string | null) => {
    const cached = panelCacheByTabId.get(tabId) ?? null
    if (!cached) return null
    if (url && cached.url !== url) return null
    return cached
  }

  const ensureChatExtract = async (
    session: PanelSession,
    tab: chrome.tabs.Tab,
    settings: Awaited<ReturnType<typeof loadSettings>>
  ) => {
    if (!tab.id || !tab.url) {
      throw new Error('Cannot chat on this page')
    }

    const preferUrl = shouldPreferUrlMode(tab.url)
    const cached = getCachedExtract(tab.id, tab.url)
    if (cached && (!preferUrl || cached.source === 'url')) return cached

    if (!preferUrl) {
      const extractedAttempt = await extractFromTab(tab.id, CHAT_FULL_TRANSCRIPT_MAX_CHARS)
      if (extractedAttempt.ok) {
        const extracted = extractedAttempt.data
        const text = extracted.text.trim()
        if (text.length >= MIN_CHAT_CHARS) {
          const wordCount = text.length > 0 ? text.split(/\s+/).filter(Boolean).length : 0
          const next = {
            url: extracted.url,
            title: extracted.title ?? tab.title?.trim() ?? null,
            text: extracted.text,
            source: 'page' as const,
            truncated: extracted.truncated,
            totalCharacters: extracted.text.length,
            wordCount,
            media: extracted.media ?? null,
            transcriptSource: null,
            transcriptionProvider: null,
            transcriptCharacters: null,
            transcriptWordCount: null,
            transcriptLines: null,
            transcriptTimedText: null,
            mediaDurationSeconds: extracted.mediaDurationSeconds ?? null,
            slides: null,
            diagnostics: null,
          }
          cachedExtracts.set(tab.id, next)
          return next
        }
      } else if (
        extractedAttempt.error.toLowerCase().includes('chrome blocked') ||
        extractedAttempt.error.toLowerCase().includes('failed to inject')
      ) {
        throw new Error(extractedAttempt.error)
      }
    }

    const wantsSlides = settings.slidesEnabled && shouldPreferUrlMode(tab.url)
    const urlStatusLabel = wantsSlides
      ? 'Extracting video + thumbnails…'
      : 'Extracting video transcript…'
    sendStatus(session, urlStatusLabel)
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
        timestamps: true,
        ...(wantsSlides ? { slides: true } : {}),
        maxCharacters: null,
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
        transcriptCharacters?: number | null
        transcriptWordCount?: number | null
        transcriptLines?: number | null
        transcriptionProvider?: string | null
        transcriptTimedText?: string | null
        mediaDurationSeconds?: number | null
        diagnostics?: {
          strategy: string
          markdown?: { used?: boolean; provider?: string | null } | null
          firecrawl?: { used?: boolean } | null
          transcript?: {
            provider?: string | null
            cacheStatus?: string | null
            attemptedProviders?: string[] | null
          } | null
        }
      }
      slides?: SlidesPayload | null
      error?: string
    }
    if (!res.ok || !json.ok || !json.extracted) {
      throw new Error(json.error || `${res.status} ${res.statusText}`)
    }

    const next = {
      url: json.extracted.url,
      title: json.extracted.title,
      text: json.extracted.content,
      source: 'url' as const,
      truncated: json.extracted.truncated,
      totalCharacters: json.extracted.totalCharacters,
      wordCount: json.extracted.wordCount,
      media: null,
      transcriptSource: json.extracted.transcriptSource ?? null,
      transcriptionProvider: json.extracted.transcriptionProvider ?? null,
      transcriptCharacters: json.extracted.transcriptCharacters ?? null,
      transcriptWordCount: json.extracted.transcriptWordCount ?? null,
      transcriptLines: json.extracted.transcriptLines ?? null,
      transcriptTimedText: json.extracted.transcriptTimedText ?? null,
      mediaDurationSeconds: json.extracted.mediaDurationSeconds ?? null,
      slides: json.slides ?? null,
      diagnostics: json.extracted.diagnostics ?? null,
    }
    if (!next.mediaDurationSeconds) {
      const fallback = await extractFromTab(tab.id, CHAT_FULL_TRANSCRIPT_MAX_CHARS)
      if (fallback.ok) {
        const duration = fallback.data.mediaDurationSeconds
        if (typeof duration === 'number' && Number.isFinite(duration) && duration > 0) {
          next.mediaDurationSeconds = duration
        }
        if (!next.media) {
          next.media = fallback.data.media ?? null
        }
      }
    }
    cachedExtracts.set(tab.id, next)
    return next
  }

  const send = (session: PanelSession, msg: BgToPanel) => {
    if (!isPanelOpen(session)) return
    try {
      session.port.postMessage(msg)
    } catch {
      // ignore (panel closed / reloading)
    }
  }
  const sendStatus = (session: PanelSession, status: string) =>
    void send(session, { type: 'ui:status', status })

  const sendHover = async (tabId: number, msg: BgToHover) => {
    try {
      await chrome.tabs.sendMessage(tabId, msg)
    } catch {
      // ignore (tab closed / navigated / no content script)
    }
  }

  const emitState = async (
    session: PanelSession,
    status: string,
    opts?: { checkRecovery?: boolean }
  ) => {
    const settings = await loadSettings()
    const tab = await getActiveTab(session.windowId)
    const health = await daemonHealth()
    const authed = settings.token.trim() ? await daemonPing(settings.token.trim()) : { ok: false }
    const daemonReady = health.ok && authed.ok
    const pendingUrl = session.daemonRecovery.getPendingUrl()
    const currentUrlMatches = Boolean(pendingUrl && tab?.url && urlsMatch(tab.url, pendingUrl))
    const isIdle = !session.runController && !session.inflightUrl
    const cached = tab?.id ? getCachedExtract(tab.id, tab.url ?? null) : null
    let shouldRecover = false
    if (opts?.checkRecovery) {
      shouldRecover = session.daemonRecovery.maybeRecover({
        isReady: daemonReady,
        currentUrlMatches,
        isIdle,
      })
    } else {
      session.daemonRecovery.updateStatus(daemonReady)
    }
    const state: UiState = {
      panelOpen: isPanelOpen(session),
      daemon: { ok: health.ok, authed: authed.ok, error: health.error ?? authed.error },
      tab: { id: tab?.id ?? null, url: tab?.url ?? null, title: tab?.title ?? null },
      media: cached?.media ?? null,
      stats: {
        pageWords: typeof cached?.wordCount === 'number' ? cached.wordCount : null,
        videoDurationSeconds:
          typeof cached?.mediaDurationSeconds === 'number' ? cached.mediaDurationSeconds : null,
      },
      settings: {
        autoSummarize: settings.autoSummarize,
        hoverSummaries: settings.hoverSummaries,
        chatEnabled: settings.chatEnabled,
        automationEnabled: settings.automationEnabled,
        slidesEnabled: settings.slidesEnabled,
        slidesLayout: settings.slidesLayout,
        fontSize: settings.fontSize,
        lineHeight: settings.lineHeight,
        model: settings.model,
        length: settings.length,
        tokenPresent: Boolean(settings.token.trim()),
      },
      status,
    }
    void send(session, { type: 'ui:state', state })

    if (shouldRecover) {
      void summarizeActiveTab(session, 'daemon-recovered')
      return
    }

    if (pendingUrl && tab?.url && !currentUrlMatches) {
      session.daemonRecovery.clearPending()
    }

    if (tab?.id && tab.url && canSummarizeUrl(tab.url)) {
      void primeMediaHint(session, {
        tabId: tab.id,
        url: tab.url,
        title: tab.title ?? null,
      })
    }
  }

  const primeMediaHint = async (
    session: PanelSession,
    {
      tabId,
      url,
      title,
    }: {
      tabId: number
      url: string
      title: string | null
    }
  ) => {
    const lastProbeUrl = lastMediaProbeByTab.get(tabId)
    if (lastProbeUrl && urlsMatch(lastProbeUrl, url)) return
    const existing = getCachedExtract(tabId, url)
    if (existing?.media) {
      lastMediaProbeByTab.set(tabId, url)
      return
    }

    lastMediaProbeByTab.set(tabId, url)
    const attempt = await extractFromTab(tabId, 1200)
    if (!attempt.ok) return
    const extracted = attempt.data
    if (!extracted.media) return

    const wordCount =
      extracted.text.length > 0 ? extracted.text.split(/\s+/).filter(Boolean).length : 0
    cachedExtracts.set(tabId, {
      url: extracted.url,
      title: extracted.title ?? title,
      text: extracted.text,
      source: 'page',
      truncated: extracted.truncated,
      totalCharacters: extracted.text.length,
      wordCount,
      media: extracted.media,
      transcriptSource: null,
      transcriptionProvider: null,
      transcriptCharacters: null,
      transcriptWordCount: null,
      transcriptLines: null,
      transcriptTimedText: null,
      mediaDurationSeconds: extracted.mediaDurationSeconds ?? null,
      slides: null,
      diagnostics: null,
    })

    void emitState(session, '')
  }

  const summarizeActiveTab = async (
    session: PanelSession,
    reason: string,
    opts?: { refresh?: boolean; inputMode?: 'page' | 'video' }
  ) => {
    if (!isPanelOpen(session)) return

    const settings = await loadSettings()
    const isManual = reason === 'manual' || reason === 'refresh' || reason === 'length-change'
    if (!isManual && !settings.autoSummarize) return
    if (!settings.token.trim()) {
      await emitState(session, 'Setup required (missing token)')
      return
    }

    const logPanel = (event: string, detail?: Record<string, unknown>) => {
      if (!settings.extendedLogging) return
      const payload = detail ? { event, ...detail } : { event }
      console.debug('[summarize][panel:bg]', payload)
    }

    if (reason === 'spa-nav' || reason === 'tab-url-change') {
      await new Promise((resolve) => setTimeout(resolve, 220))
    }

    const tab = await getActiveTab(session.windowId)
    if (!tab?.id || !canSummarizeUrl(tab.url)) return

    session.runController?.abort()
    const controller = new AbortController()
    session.runController = controller

    const prefersUrlMode = Boolean(tab.url && shouldPreferUrlMode(tab.url))
    const wantsUrlFastPath =
      Boolean(tab.url && isYouTubeWatchUrl(tab.url)) && opts?.inputMode !== 'page' && prefersUrlMode

    let extracted: ExtractResponse & { ok: true }
    if (wantsUrlFastPath) {
      sendStatus(session, `Fetching transcript… (${reason})`)
      logPanel('extract:url-fastpath:start', { reason, tabId: tab.id })
      try {
        const res = await fetch('http://127.0.0.1:8787/v1/summarize', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${settings.token.trim()}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            url: tab.url,
            title: tab.title ?? null,
            mode: 'url',
            extractOnly: true,
            timestamps: true,
            ...(opts?.refresh ? { noCache: true } : {}),
            maxCharacters: null,
            diagnostics: settings.extendedLogging ? { includeContent: true } : null,
          }),
          signal: controller.signal,
        })
        const json = (await res.json()) as {
          ok?: boolean
          extracted?: {
            url: string
            title: string | null
            content: string
            truncated: boolean
            mediaDurationSeconds?: number | null
            transcriptTimedText?: string | null
          }
          error?: string
        }
        if (!res.ok || !json.ok || !json.extracted) {
          throw new Error(json.error || `${res.status} ${res.statusText}`)
        }
        const extractedUrl = json.extracted.url || tab.url
        extracted = {
          ok: true,
          url: extractedUrl,
          title: json.extracted.title ?? tab.title ?? null,
          text: '',
          truncated: Boolean(json.extracted.truncated),
          media: { hasVideo: true, hasAudio: true, hasCaptions: true },
          mediaDurationSeconds: json.extracted.mediaDurationSeconds ?? null,
        }
        cachedExtracts.set(tab.id, {
          url: extractedUrl,
          title: extracted.title ?? null,
          text: '',
          source: 'url',
          truncated: Boolean(json.extracted.truncated),
          totalCharacters: 0,
          wordCount: null,
          media: { hasVideo: true, hasAudio: true, hasCaptions: true },
          transcriptSource: null,
          transcriptionProvider: null,
          transcriptCharacters: null,
          transcriptWordCount: null,
          transcriptLines: null,
          transcriptTimedText: json.extracted.transcriptTimedText ?? null,
          mediaDurationSeconds: json.extracted.mediaDurationSeconds ?? null,
          slides: null,
          diagnostics: null,
        })
        logPanel('extract:url-fastpath:ok', {
          url: extractedUrl,
          transcriptTimedText: Boolean(json.extracted.transcriptTimedText),
          durationSeconds: json.extracted.mediaDurationSeconds ?? null,
        })
      } catch (err) {
        logPanel('extract:url-fastpath:error', {
          error: err instanceof Error ? err.message : String(err),
        })
        extracted = {
          ok: true,
          url: tab.url,
          title: tab.title ?? null,
          text: '',
          truncated: false,
          media: { hasVideo: true, hasAudio: true, hasCaptions: true },
        }
      }
    } else {
      sendStatus(session, `Extracting… (${reason})`)
      logPanel('extract:start', { reason, tabId: tab.id, maxChars: settings.maxChars })
      const statusFromExtractEvent = (event: string) => {
        if (!isPanelOpen(session)) return
        if (event === 'extract:attempt') {
          sendStatus(session, `Extracting page content… (${reason})`)
          return
        }
        if (event === 'extract:inject:ok') {
          sendStatus(session, `Extracting: injecting… (${reason})`)
          return
        }
        if (event === 'extract:message:ok') {
          sendStatus(session, `Extracting: reading… (${reason})`)
        }
      }
      const extractedAttempt = await extractFromTab(tab.id, settings.maxChars, {
        timeoutMs: 8_000,
        log: (event, detail) => {
          statusFromExtractEvent(event)
          logPanel(event, detail)
        },
      })
      logPanel(extractedAttempt.ok ? 'extract:done' : 'extract:failed', {
        ok: extractedAttempt.ok,
        ...(extractedAttempt.ok
          ? { url: extractedAttempt.data.url }
          : { error: extractedAttempt.error }),
      })
      extracted = extractedAttempt.ok
        ? extractedAttempt.data
        : {
            ok: true,
            url: tab.url,
            title: tab.title ?? null,
            text: '',
            truncated: false,
            media: null,
          }
    }

    if (tab.url && extracted.url && !urlsMatch(tab.url, extracted.url)) {
      await new Promise((resolve) => setTimeout(resolve, 180))
      logPanel('extract:retry', { tabId: tab.id, maxChars: settings.maxChars })
      const retry = await extractFromTab(tab.id, settings.maxChars, {
        timeoutMs: 8_000,
        log: (event, detail) => logPanel(event, detail),
      })
      if (retry.ok) {
        extracted = retry.data
      }
    }

    const extractedMatchesTab = tab.url && extracted.url ? urlsMatch(tab.url, extracted.url) : true
    const resolvedExtracted =
      tab.url && !extractedMatchesTab
        ? {
            ok: true,
            url: tab.url,
            title: tab.title ?? null,
            text: '',
            truncated: false,
            media: null,
          }
        : extracted

    if (!extracted) return

    if (
      settings.autoSummarize &&
      ((session.lastSummarizedUrl && urlsMatch(session.lastSummarizedUrl, resolvedExtracted.url)) ||
        (session.inflightUrl && urlsMatch(session.inflightUrl, resolvedExtracted.url))) &&
      !isManual
    ) {
      sendStatus(session, '')
      return
    }

    const resolvedTitle = tab.title?.trim() || resolvedExtracted.title || null
    const resolvedPayload = { ...resolvedExtracted, title: resolvedTitle }
    const effectiveInputMode =
      opts?.inputMode ??
      (resolvedPayload.url && shouldPreferUrlMode(resolvedPayload.url) ? 'video' : undefined)
    const wordCount =
      resolvedPayload.text.length > 0 ? resolvedPayload.text.split(/\s+/).filter(Boolean).length : 0
    const wantsSummaryTimestamps =
      settings.summaryTimestamps &&
      (effectiveInputMode === 'video' ||
        resolvedPayload.media?.hasVideo === true ||
        resolvedPayload.media?.hasAudio === true ||
        resolvedPayload.media?.hasCaptions === true ||
        shouldPreferUrlMode(resolvedPayload.url))
    const wantsSlides =
      settings.slidesEnabled &&
      (effectiveInputMode === 'video' ||
        resolvedPayload.media?.hasVideo === true ||
        shouldPreferUrlMode(resolvedPayload.url))

    const resolveSlidesForLength = (
      lengthValue: string,
      durationSeconds: number | null | undefined
    ): { maxSlides: number | null; minDurationSeconds: number | null } => {
      if (!durationSeconds || !Number.isFinite(durationSeconds) || durationSeconds <= 0) {
        return { maxSlides: null, minDurationSeconds: null }
      }
      const normalized = lengthValue.trim().toLowerCase()
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
      const maxSlides = Math.max(3, Math.min(80, target))
      const minDuration = Math.max(2, Math.floor(durationSeconds / maxSlides))
      return { maxSlides, minDurationSeconds: minDuration }
    }
    logPanel('summarize:start', {
      reason,
      url: resolvedPayload.url,
      inputMode: effectiveInputMode ?? null,
      wantsSummaryTimestamps,
      wantsSlides,
    })

    cachedExtracts.set(tab.id, {
      url: resolvedPayload.url,
      title: resolvedTitle,
      text: resolvedPayload.text,
      source: 'page',
      truncated: resolvedPayload.truncated,
      totalCharacters: resolvedPayload.text.length,
      wordCount,
      media: resolvedPayload.media ?? null,
      transcriptSource: null,
      transcriptionProvider: null,
      transcriptCharacters: null,
      transcriptWordCount: null,
      transcriptLines: null,
      transcriptTimedText: null,
      mediaDurationSeconds: resolvedPayload.mediaDurationSeconds ?? null,
      slides: null,
      diagnostics: null,
    })

    sendStatus(session, 'Connecting…')
    session.inflightUrl = resolvedPayload.url
    let id: string
    try {
      const slideAuto = wantsSlides
        ? resolveSlidesForLength(settings.length, resolvedPayload.mediaDurationSeconds)
        : { maxSlides: null, minDurationSeconds: null }
      const body = buildSummarizeRequestBody({
        extracted: resolvedPayload,
        settings,
        noCache: Boolean(opts?.refresh),
        inputMode: effectiveInputMode,
        timestamps: wantsSummaryTimestamps,
        slides: wantsSlides
          ? {
              enabled: true,
              ocr: true,
              maxSlides: slideAuto.maxSlides,
              minDurationSeconds: slideAuto.minDurationSeconds,
            }
          : { enabled: false },
      })
      logPanel('summarize:request', {
        url: resolvedPayload.url,
        slides: wantsSlides,
        timestamps: wantsSummaryTimestamps,
      })
      const res = await fetch('http://127.0.0.1:8787/v1/summarize', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${settings.token.trim()}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      })
      const json = (await res.json()) as { ok: boolean; id?: string; error?: string }
      if (!res.ok || !json.ok || !json.id) {
        throw new Error(json.error || `${res.status} ${res.statusText}`)
      }
      id = json.id
    } catch (err) {
      if (controller.signal.aborted) return
      const message = friendlyFetchError(err, 'Daemon request failed')
      void send(session, { type: 'run:error', message })
      sendStatus(session, `Error: ${message}`)
      session.inflightUrl = null
      if (!isManual && isDaemonUnreachableError(err)) {
        session.daemonRecovery.recordFailure(resolvedPayload.url)
      }
      return
    }

    void send(session, {
      type: 'run:start',
      run: { id, url: resolvedPayload.url, title: resolvedTitle, model: settings.model, reason },
    })
  }

  const abortHoverForTab = (tabId: number, requestId?: string) => {
    const existing = hoverControllersByTabId.get(tabId)
    if (!existing) return
    if (requestId && existing.requestId !== requestId) return
    existing.controller.abort()
    hoverControllersByTabId.delete(tabId)
  }

  const resolveHoverTabId = async (
    sender: chrome.runtime.MessageSender
  ): Promise<number | null> => {
    if (sender.tab?.id) return sender.tab.id
    const senderUrl = typeof sender.url === 'string' ? sender.url : null
    const tabs = await chrome.tabs.query({})
    if (senderUrl) {
      const match = tabs.find((tab) => tab.url === senderUrl)
      if (match?.id) return match.id
    }
    const active = tabs.find((tab) => tab.active)
    return active?.id ?? null
  }

  const runHoverSummarize = async (
    tabId: number,
    msg: HoverToBg & { type: 'hover:summarize' },
    opts?: { onStart?: (result: { ok: boolean; error?: string }) => void }
  ) => {
    abortHoverForTab(tabId)
    let didNotifyStart = false
    const notifyStart = (result: { ok: boolean; error?: string }) => {
      if (didNotifyStart) return
      didNotifyStart = true
      opts?.onStart?.(result)
    }

    // Keep localhost daemon calls out of content-script/page context to avoid Chrome’s “Local network access”
    // prompt per-origin. Background SW owns `fetch("http://127.0.0.1:8787/...")` for hover summaries.
    const controller = new AbortController()
    hoverControllersByTabId.set(tabId, { requestId: msg.requestId, controller })

    const isStillActive = () => {
      const current = hoverControllersByTabId.get(tabId)
      return Boolean(current && current.requestId === msg.requestId && !controller.signal.aborted)
    }

    const settings = await loadSettings()
    const logHover = (event: string, detail?: Record<string, unknown>) => {
      if (!settings.extendedLogging) return
      const payload = detail ? { event, ...detail } : { event }
      console.debug('[summarize][hover:bg]', payload)
    }
    const token = msg.token?.trim() || settings.token.trim()
    if (!token) {
      notifyStart({ ok: false, error: 'Setup required (missing token)' })
      await sendHover(tabId, {
        type: 'hover:error',
        requestId: msg.requestId,
        url: msg.url,
        message: 'Setup required (missing token)',
      })
      return
    }

    try {
      logHover('start', { tabId, requestId: msg.requestId, url: msg.url })
      const base = buildDaemonRequestBody({
        extracted: { url: msg.url, title: msg.title, text: '', truncated: false },
        settings,
      })
      const body = {
        ...base,
        length: 'short',
        prompt: settings.hoverPrompt,
        mode: 'url',
        timeout: '30s',
      }

      const res = await fetch('http://127.0.0.1:8787/v1/summarize', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      })

      const json = (await res.json()) as { ok?: boolean; id?: string; error?: string }
      if (!res.ok || !json?.ok || !json.id) {
        throw new Error(json?.error || `${res.status} ${res.statusText}`)
      }

      if (!isStillActive()) return
      notifyStart({ ok: true })
      logHover('stream-start', { tabId, requestId: msg.requestId, url: msg.url, runId: json.id })

      const streamRes = await fetch(`http://127.0.0.1:8787/v1/summarize/${json.id}/events`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: controller.signal,
      })
      if (!streamRes.ok) throw new Error(`${streamRes.status} ${streamRes.statusText}`)
      if (!streamRes.body) throw new Error('Missing stream body')

      for await (const raw of parseSseStream(streamRes.body)) {
        if (!isStillActive()) return
        const event = parseSseEvent(raw)
        if (!event) continue

        if (event.event === 'chunk') {
          await sendHover(tabId, {
            type: 'hover:chunk',
            requestId: msg.requestId,
            url: msg.url,
            text: event.data.text,
          })
        } else if (event.event === 'error') {
          throw new Error(event.data.message)
        } else if (event.event === 'done') {
          break
        }
      }

      if (!isStillActive()) return
      logHover('done', { tabId, requestId: msg.requestId, url: msg.url })
      await sendHover(tabId, { type: 'hover:done', requestId: msg.requestId, url: msg.url })
    } catch (err) {
      if (!isStillActive()) return
      notifyStart({
        ok: false,
        error: friendlyFetchError(err, 'Hover summarize failed'),
      })
      logHover('error', {
        tabId,
        requestId: msg.requestId,
        url: msg.url,
        message: err instanceof Error ? err.message : String(err),
      })
      await sendHover(tabId, {
        type: 'hover:error',
        requestId: msg.requestId,
        url: msg.url,
        message: friendlyFetchError(err, 'Hover summarize failed'),
      })
    } finally {
      notifyStart({ ok: false, error: 'Hover summarize aborted' })
      abortHoverForTab(tabId, msg.requestId)
    }
  }

  const handlePanelMessage = (session: PanelSession, raw: PanelToBg) => {
    if (!raw || typeof raw !== 'object' || typeof (raw as { type?: unknown }).type !== 'string') {
      return
    }
    const type = raw.type
    if (type !== 'panel:closed') {
      session.panelOpen = true
    }
    if (type === 'panel:ping') session.panelLastPingAt = Date.now()

    switch (type) {
      case 'panel:ready':
        session.panelOpen = true
        session.panelLastPingAt = Date.now()
        session.lastSummarizedUrl = null
        session.inflightUrl = null
        session.runController?.abort()
        session.runController = null
        session.agentController?.abort()
        session.agentController = null
        session.daemonRecovery.clearPending()
        void emitState(session, '')
        void summarizeActiveTab(session, 'panel-open')
        break
      case 'panel:closed':
        session.panelOpen = false
        session.panelLastPingAt = 0
        session.runController?.abort()
        session.runController = null
        session.agentController?.abort()
        session.agentController = null
        session.lastSummarizedUrl = null
        session.inflightUrl = null
        session.daemonRecovery.clearPending()
        void clearCachedExtractsForWindow(session.windowId)
        break
      case 'panel:summarize':
        void summarizeActiveTab(
          session,
          (raw as { refresh?: boolean }).refresh ? 'refresh' : 'manual',
          {
            refresh: Boolean((raw as { refresh?: boolean }).refresh),
            inputMode: (raw as { inputMode?: 'page' | 'video' }).inputMode,
          }
        )
        break
      case 'panel:cache': {
        const payload = (raw as { cache?: PanelCachePayload }).cache
        if (!payload || typeof payload.tabId !== 'number' || !payload.url) return
        storePanelCache(payload)
        break
      }
      case 'panel:get-cache': {
        const payload = raw as { requestId: string; tabId: number; url: string }
        if (!payload.requestId || !payload.tabId || !payload.url) {
          return
        }
        const cached = getPanelCache(payload.tabId, payload.url)
        void send(session, {
          type: 'ui:cache',
          requestId: payload.requestId,
          ok: Boolean(cached),
          cache: cached ?? undefined,
        })
        break
      }
      case 'panel:agent':
        void (async () => {
          const settings = await loadSettings()
          if (!settings.chatEnabled) {
            void send(session, { type: 'run:error', message: 'Chat is disabled in settings' })
            return
          }
          if (!settings.token.trim()) {
            void send(session, { type: 'run:error', message: 'Setup required (missing token)' })
            return
          }

          const tab = await getActiveTab(session.windowId)
          if (!tab?.id || !canSummarizeUrl(tab.url)) {
            void send(session, { type: 'run:error', message: 'Cannot chat on this page' })
            return
          }

          let cachedExtract: CachedExtract
          try {
            cachedExtract = await ensureChatExtract(session, tab, settings)
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err)
            void send(session, { type: 'run:error', message })
            sendStatus(session, `Error: ${message}`)
            return
          }

          session.agentController?.abort()
          const agentController = new AbortController()
          session.agentController = agentController
          const isStillActive = () =>
            session.agentController === agentController && !agentController.signal.aborted

          const agentPayload = raw as {
            requestId: string
            messages: Message[]
            tools: string[]
            summary?: string | null
          }
          const summaryText =
            typeof agentPayload.summary === 'string' ? agentPayload.summary.trim() : ''
          const slidesContext = buildSlidesText(cachedExtract.slides)
          const pageContent = buildChatPageContent({
            transcript: cachedExtract.transcriptTimedText ?? cachedExtract.text,
            summary: summaryText,
            summaryCap: settings.maxChars,
            slides: slidesContext,
            metadata: {
              url: cachedExtract.url,
              title: cachedExtract.title,
              source: cachedExtract.source,
              extractionStrategy:
                cachedExtract.source === 'page'
                  ? 'readability (content script)'
                  : (cachedExtract.diagnostics?.strategy ?? null),
              markdownProvider: cachedExtract.diagnostics?.markdown?.used
                ? (cachedExtract.diagnostics?.markdown?.provider ?? 'unknown')
                : null,
              firecrawlUsed: cachedExtract.diagnostics?.firecrawl?.used ?? null,
              transcriptSource: cachedExtract.transcriptSource,
              transcriptionProvider: cachedExtract.transcriptionProvider,
              transcriptCache: cachedExtract.diagnostics?.transcript?.cacheStatus ?? null,
              attemptedTranscriptProviders:
                cachedExtract.diagnostics?.transcript?.attemptedProviders ?? null,
              mediaDurationSeconds: cachedExtract.mediaDurationSeconds,
              totalCharacters: cachedExtract.totalCharacters,
              wordCount: cachedExtract.wordCount,
              transcriptCharacters: cachedExtract.transcriptCharacters,
              transcriptWordCount: cachedExtract.transcriptWordCount,
              transcriptLines: cachedExtract.transcriptLines,
              transcriptHasTimestamps: Boolean(cachedExtract.transcriptTimedText),
              truncated: cachedExtract.truncated,
            },
          })
          const cacheContent = cachedExtract.transcriptTimedText ?? cachedExtract.text

          sendStatus(session, 'Sending to AI…')

          try {
            const res = await fetch('http://127.0.0.1:8787/v1/agent', {
              method: 'POST',
              headers: {
                Authorization: `Bearer ${settings.token.trim()}`,
                'content-type': 'application/json',
                Accept: 'text/event-stream',
              },
              body: JSON.stringify({
                url: cachedExtract.url,
                title: cachedExtract.title,
                pageContent,
                cacheContent,
                messages: agentPayload.messages,
                model: settings.model,
                length: settings.length,
                language: settings.language,
                tools: agentPayload.tools,
                automationEnabled: settings.automationEnabled,
              }),
              signal: agentController.signal,
            })
            if (!res.ok) {
              const rawText = await res.text().catch(() => '')
              const isMissingAgent =
                res.status === 404 || rawText.trim().toLowerCase() === 'not found'
              const error = isMissingAgent
                ? 'Daemon does not support /v1/agent. Restart the daemon after updating (summarize daemon restart).'
                : rawText.trim() || `${res.status} ${res.statusText}`
              throw new Error(error)
            }

            let sawAssistant = false
            for await (const event of readAgentResponse(res)) {
              if (!isStillActive()) return
              if (event.type === 'chunk') {
                void send(session, {
                  type: 'agent:chunk',
                  requestId: agentPayload.requestId,
                  text: event.text,
                })
              } else if (event.type === 'assistant') {
                sawAssistant = true
                void send(session, {
                  type: 'agent:response',
                  requestId: agentPayload.requestId,
                  ok: true,
                  assistant: event.assistant,
                })
              }
            }

            if (!sawAssistant) {
              throw new Error('Agent stream ended without a response.')
            }

            sendStatus(session, '')
          } catch (err) {
            if (agentController.signal.aborted) return
            const message = friendlyFetchError(err, 'Chat request failed')
            void send(session, {
              type: 'agent:response',
              requestId: agentPayload.requestId,
              ok: false,
              error: message,
            })
            sendStatus(session, `Error: ${message}`)
          } finally {
            if (session.agentController === agentController) {
              session.agentController = null
            }
          }
        })()
        break
      case 'panel:chat-history':
        void (async () => {
          const payload = raw as { requestId: string; summary?: string | null }
          const settings = await loadSettings()
          if (!settings.chatEnabled) {
            void send(session, {
              type: 'chat:history',
              requestId: payload.requestId,
              ok: false,
              error: 'Chat is disabled in settings',
            })
            return
          }
          if (!settings.token.trim()) {
            void send(session, {
              type: 'chat:history',
              requestId: payload.requestId,
              ok: false,
              error: 'Setup required (missing token)',
            })
            return
          }

          const tab = await getActiveTab(session.windowId)
          if (!tab?.id || !canSummarizeUrl(tab.url)) {
            void send(session, {
              type: 'chat:history',
              requestId: payload.requestId,
              ok: false,
              error: 'Cannot chat on this page',
            })
            return
          }

          let cachedExtract: CachedExtract
          try {
            cachedExtract = await ensureChatExtract(session, tab, settings)
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err)
            void send(session, {
              type: 'chat:history',
              requestId: payload.requestId,
              ok: false,
              error: message,
            })
            return
          }

          const summaryText = typeof payload.summary === 'string' ? payload.summary.trim() : ''
          const pageContent = buildChatPageContent({
            transcript: cachedExtract.transcriptTimedText ?? cachedExtract.text,
            summary: summaryText,
            summaryCap: settings.maxChars,
            metadata: {
              url: cachedExtract.url,
              title: cachedExtract.title,
              source: cachedExtract.source,
              extractionStrategy:
                cachedExtract.source === 'page'
                  ? 'readability (content script)'
                  : (cachedExtract.diagnostics?.strategy ?? null),
              markdownProvider: cachedExtract.diagnostics?.markdown?.used
                ? (cachedExtract.diagnostics?.markdown?.provider ?? 'unknown')
                : null,
              firecrawlUsed: cachedExtract.diagnostics?.firecrawl?.used ?? null,
              transcriptSource: cachedExtract.transcriptSource,
              transcriptionProvider: cachedExtract.transcriptionProvider,
              transcriptCache: cachedExtract.diagnostics?.transcript?.cacheStatus ?? null,
              attemptedTranscriptProviders:
                cachedExtract.diagnostics?.transcript?.attemptedProviders ?? null,
              mediaDurationSeconds: cachedExtract.mediaDurationSeconds,
              totalCharacters: cachedExtract.totalCharacters,
              wordCount: cachedExtract.wordCount,
              transcriptCharacters: cachedExtract.transcriptCharacters,
              transcriptWordCount: cachedExtract.transcriptWordCount,
              transcriptLines: cachedExtract.transcriptLines,
              transcriptHasTimestamps: Boolean(cachedExtract.transcriptTimedText),
              truncated: cachedExtract.truncated,
            },
          })
          const cacheContent = cachedExtract.transcriptTimedText ?? cachedExtract.text

          try {
            const res = await fetch('http://127.0.0.1:8787/v1/agent/history', {
              method: 'POST',
              headers: {
                Authorization: `Bearer ${settings.token.trim()}`,
                'content-type': 'application/json',
              },
              body: JSON.stringify({
                url: cachedExtract.url,
                title: cachedExtract.title,
                pageContent,
                cacheContent,
                model: settings.model,
                length: settings.length,
                language: settings.language,
                automationEnabled: settings.automationEnabled,
              }),
            })
            const rawText = await res.text()
            let json: { ok?: boolean; messages?: Message[]; error?: string } | null = null
            if (rawText) {
              try {
                json = JSON.parse(rawText) as typeof json
              } catch {
                json = null
              }
            }
            if (!res.ok || !json?.ok) {
              const error = json?.error ?? (rawText.trim() || `${res.status} ${res.statusText}`)
              throw new Error(error)
            }
            void send(session, {
              type: 'chat:history',
              requestId: payload.requestId,
              ok: true,
              messages: Array.isArray(json?.messages) ? json?.messages : undefined,
            })
          } catch (err) {
            const message = friendlyFetchError(err, 'Chat history request failed')
            void send(session, {
              type: 'chat:history',
              requestId: payload.requestId,
              ok: false,
              error: message,
            })
          }
        })()
        break
      case 'panel:ping':
        void emitState(session, '', { checkRecovery: true })
        break
      case 'panel:rememberUrl':
        session.lastSummarizedUrl = (raw as { url: string }).url
        session.inflightUrl = null
        break
      case 'panel:setAuto':
        void (async () => {
          await patchSettings({ autoSummarize: (raw as { value: boolean }).value })
          void emitState(session, '')
          if ((raw as { value: boolean }).value) void summarizeActiveTab(session, 'auto-enabled')
        })()
        break
      case 'panel:setLength':
        void (async () => {
          const next = (raw as { value: string }).value
          const current = await loadSettings()
          if (current.length === next) return
          await patchSettings({ length: next })
          void emitState(session, '')
          void summarizeActiveTab(session, 'length-change')
        })()
        break
      case 'panel:slides-context':
        void (async () => {
          const requestId = (raw as { requestId?: string }).requestId
          if (!requestId) return
          const settings = await loadSettings()
          const logSlides = (event: string, detail?: Record<string, unknown>) => {
            if (!settings.extendedLogging) return
            const payload = detail ? { event, ...detail } : { event }
            console.debug('[summarize][slides:bg]', payload)
          }
          const tab = await getActiveTab(session.windowId)
          if (!tab?.id || !canSummarizeUrl(tab.url)) {
            void send(session, {
              type: 'slides:context',
              requestId,
              ok: false,
              error: 'No active tab for slides.',
            })
            logSlides('context:error', { reason: 'no-tab' })
            return
          }
          let cached = getCachedExtract(tab.id, tab.url ?? null)
          let transcriptTimedText = cached?.transcriptTimedText ?? null
          if (!transcriptTimedText && settings.token.trim()) {
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
                  timestamps: true,
                  maxCharacters: null,
                }),
              })
              const json = (await res.json()) as {
                ok?: boolean
                extracted?: { transcriptTimedText?: string | null } | null
                error?: string
              }
              if (!res.ok || !json?.ok) {
                throw new Error(json?.error || `${res.status} ${res.statusText}`)
              }
              transcriptTimedText = json.extracted?.transcriptTimedText ?? null
              if (transcriptTimedText) {
                if (!cached) {
                  cached = {
                    url: tab.url,
                    title: tab.title?.trim() ?? null,
                    text: '',
                    source: 'url',
                    truncated: false,
                    totalCharacters: 0,
                    wordCount: null,
                    media: null,
                    transcriptSource: null,
                    transcriptionProvider: null,
                    transcriptCharacters: null,
                    transcriptWordCount: null,
                    transcriptLines: null,
                    transcriptTimedText,
                    mediaDurationSeconds: null,
                    slides: null,
                    diagnostics: null,
                  }
                } else {
                  cached = { ...cached, transcriptTimedText }
                }
                cachedExtracts.set(tab.id, cached)
              }
              logSlides('context:fetch-transcript', {
                ok: Boolean(transcriptTimedText),
                url: tab.url,
              })
            } catch (err) {
              logSlides('context:fetch-error', {
                url: tab.url,
                error: err instanceof Error ? err.message : String(err),
              })
            }
          }
          void send(session, {
            type: 'slides:context',
            requestId,
            ok: true,
            transcriptTimedText,
          })
          logSlides('context:ready', {
            url: tab.url,
            transcriptTimedText: Boolean(transcriptTimedText),
            slides: cached?.slides?.slides?.length ?? 0,
          })
        })()
        break
      case 'panel:openOptions':
        void openOptionsWindow()
        break
      case 'panel:seek':
        void (async () => {
          const seconds = (raw as { seconds?: number }).seconds
          if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0) {
            return
          }
          const tab = await getActiveTab(session.windowId)
          if (!tab?.id) return
          const result = await seekInTab(tab.id, Math.floor(seconds))
          if (!result.ok) {
            sendStatus(session, `Seek failed: ${result.error}`)
          }
        })()
        break
    }
  }

  chrome.runtime.onConnect.addListener((port) => {
    if (!port.name.startsWith('sidepanel:')) return
    const windowIdRaw = port.name.split(':')[1] ?? ''
    const windowId = Number.parseInt(windowIdRaw, 10)
    if (!Number.isFinite(windowId)) return
    const session = registerPanelSession(windowId, port)
    port.onMessage.addListener((msg) => handlePanelMessage(session, msg as PanelToBg))
    port.onDisconnect.addListener(() => {
      if (session.port !== port) return
      session.runController?.abort()
      session.runController = null
      session.panelOpen = false
      session.panelLastPingAt = 0
      session.lastSummarizedUrl = null
      session.inflightUrl = null
      session.daemonRecovery.clearPending()
      panelSessions.delete(windowId)
      getPanelPortMap().delete(windowId)
      void clearCachedExtractsForWindow(windowId)
    })
  })

  chrome.runtime.onMessage.addListener(
    (
      raw: HoverToBg | NativeInputRequest | ArtifactsRequest,
      sender,
      sendResponse
    ): boolean | undefined => {
      if (!raw || typeof raw !== 'object' || typeof (raw as { type?: unknown }).type !== 'string') {
        return
      }

      const type = (raw as { type: string }).type
      if (type === 'automation:native-input') {
        const msg = raw as NativeInputRequest
        void (async () => {
          const tabId = sender.tab?.id
          if (!tabId) {
            try {
              sendResponse({ ok: false, error: 'Missing sender tab' } satisfies NativeInputResponse)
            } catch {
              // ignore
            }
            return
          }
          const result = await dispatchNativeInput(tabId, msg.payload)
          try {
            sendResponse(result)
          } catch {
            // ignore
          }
        })()
        return true
      }
      if (type === 'automation:artifacts') {
        const msg = raw as ArtifactsRequest
        void (async () => {
          const tabId = sender.tab?.id
          if (!tabId) {
            try {
              sendResponse({ ok: false, error: 'Missing sender tab' })
            } catch {
              // ignore
            }
            return
          }

          const payload = (msg.payload ?? {}) as {
            fileName?: string
            content?: unknown
            mimeType?: string
            asBase64?: boolean
          }

          try {
            if (msg.action === 'listArtifacts') {
              const records = await listArtifacts(tabId)
              sendResponse({
                ok: true,
                result: records.map(({ fileName, mimeType, size, updatedAt }) => ({
                  fileName,
                  mimeType,
                  size,
                  updatedAt,
                })),
              })
              return
            }

            if (msg.action === 'getArtifact') {
              if (!payload.fileName) throw new Error('Missing fileName')
              const record = await getArtifactRecord(tabId, payload.fileName)
              if (!record) throw new Error(`Artifact not found: ${payload.fileName}`)
              const isText =
                record.mimeType.startsWith('text/') ||
                record.mimeType === 'application/json' ||
                record.fileName.endsWith('.json')
              const value = payload.asBase64 ? record : isText ? parseArtifact(record) : record
              sendResponse({ ok: true, result: value })
              return
            }

            if (msg.action === 'createOrUpdateArtifact') {
              if (!payload.fileName) throw new Error('Missing fileName')
              const record = await upsertArtifact(tabId, {
                fileName: payload.fileName,
                content: payload.content,
                mimeType: payload.mimeType,
                contentBase64:
                  typeof payload.content === 'object' &&
                  payload.content &&
                  'contentBase64' in payload.content
                    ? (payload.content as { contentBase64?: string }).contentBase64
                    : undefined,
              })
              sendResponse({
                ok: true,
                result: {
                  fileName: record.fileName,
                  mimeType: record.mimeType,
                  size: record.size,
                  updatedAt: record.updatedAt,
                },
              })
              return
            }

            if (msg.action === 'deleteArtifact') {
              if (!payload.fileName) throw new Error('Missing fileName')
              const deleted = await deleteArtifact(tabId, payload.fileName)
              sendResponse({ ok: true, result: { ok: deleted } })
              return
            }

            throw new Error(`Unknown artifact action: ${msg.action ?? 'unknown'}`)
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            try {
              sendResponse({ ok: false, error: message })
            } catch {
              // ignore
            }
          }
        })()
        return true
      }
      if (type === 'hover:summarize') {
        const msg = raw as HoverToBg & { type: 'hover:summarize' }
        void (async () => {
          const tabId = await resolveHoverTabId(sender)
          if (!tabId) {
            try {
              sendResponse({ ok: false, error: 'Missing sender tab' })
            } catch {
              // ignore
            }
            return
          }

          const startResult = await new Promise<{ ok: boolean; error?: string }>((resolve) => {
            void runHoverSummarize(tabId, msg, { onStart: resolve })
          })
          try {
            sendResponse(startResult)
          } catch {
            // ignore
          }
        })()
        return true
      }

      if (type === 'hover:abort') {
        const tabId = sender.tab?.id
        if (!tabId) return
        abortHoverForTab(tabId, (raw as HoverToBg & { type: 'hover:abort' }).requestId)
        return
      }
    }
  )

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local') return
    if (!changes.settings) return
    for (const session of panelSessions.values()) {
      void emitState(session, '')
    }
  })

  chrome.webNavigation.onHistoryStateUpdated.addListener((details) => {
    void (async () => {
      const tab = await chrome.tabs.get(details.tabId).catch(() => null)
      const windowId = tab?.windowId
      if (typeof windowId !== 'number') return
      const session = getPanelSession(windowId)
      if (!session) return
      const now = Date.now()
      if (now - session.lastNavAt < 700) return
      session.lastNavAt = now
      void emitState(session, '')
      void summarizeActiveTab(session, 'spa-nav')
    })()
  })

  chrome.tabs.onActivated.addListener((info) => {
    const session = getPanelSession(info.windowId)
    if (!session) return
    void emitState(session, '')
    void summarizeActiveTab(session, 'tab-activated')
  })

  chrome.tabs.onUpdated.addListener((_tabId, changeInfo, tab) => {
    const windowId = tab?.windowId
    if (typeof windowId !== 'number') return
    const session = getPanelSession(windowId)
    if (!session) return
    if (typeof changeInfo.title === 'string' || typeof changeInfo.url === 'string') {
      void emitState(session, '')
    }
    if (typeof changeInfo.url === 'string') {
      void summarizeActiveTab(session, 'tab-url-change')
    }
    if (changeInfo.status === 'complete') {
      void emitState(session, '')
      void summarizeActiveTab(session, 'tab-updated')
    }
  })

  chrome.tabs.onRemoved.addListener((tabId) => {
    cachedExtracts.delete(tabId)
    lastMediaProbeByTab.delete(tabId)
    hoverControllersByTabId.delete(tabId)
    panelCacheByTabId.delete(tabId)
  })

  // Chrome: Auto-open side panel on toolbar icon click
  if (import.meta.env.BROWSER === 'chrome') {
    void chrome.sidePanel?.setPanelBehavior?.({ openPanelOnActionClick: true })
  }

  // Firefox: Toggle sidebar on toolbar icon click
  // Firefox supports sidebarAction.toggle() for programmatic control
  if (import.meta.env.BROWSER === 'firefox') {
    chrome.action.onClicked.addListener(() => {
      // @ts-expect-error - sidebarAction API exists in Firefox but not in Chrome types
      if (typeof browser?.sidebarAction?.toggle === 'function') {
        // @ts-expect-error - Firefox-specific API
        void browser.sidebarAction.toggle()
      }
    })
  }
})
