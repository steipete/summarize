import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import { createServer as createHttpServer } from 'node:http'
import { createServer as createNetServer } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import type { BrowserContext, Page, Worker } from '@playwright/test'
import { chromium, expect, firefox, test } from '@playwright/test'

import { SUMMARY_LENGTH_SPECS } from '@steipete/summarize-core/prompts'
import { runDaemonServer } from '../../../src/daemon/server.js'
import {
  coerceSummaryWithSlides,
  parseSlideSummariesFromMarkdown,
  splitSlideTitleFromText,
} from '../../../src/run/flows/url/slides-text.js'
import type { SummaryLength } from '../../../src/shared/contracts.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(__dirname, '..', '..', '..')
const consoleErrorAllowlist: RegExp[] = []
const allowFirefoxExtensionTests = process.env.ALLOW_FIREFOX_EXTENSION_TESTS === '1'
const allowYouTubeE2E = process.env.ALLOW_YOUTUBE_E2E === '1'
const youtubeEnvUrls =
  typeof process.env.SUMMARIZE_YOUTUBE_URLS === 'string'
    ? process.env.SUMMARIZE_YOUTUBE_URLS.split(',').map((value) => value.trim())
    : []
const defaultYouTubeUrls = [
  'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
  'https://www.youtube.com/watch?v=jNQXAC9IVRw',
]
const defaultYouTubeSlidesUrls = [
  'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
  'https://www.youtube.com/watch?v=jNQXAC9IVRw',
]
const youtubeTestUrls =
  youtubeEnvUrls.filter((value) => value.length > 0).length > 0
    ? youtubeEnvUrls.filter((value) => value.length > 0)
    : defaultYouTubeUrls
const youtubeSlidesEnvUrls =
  typeof process.env.SUMMARIZE_YOUTUBE_SLIDES_URLS === 'string'
    ? process.env.SUMMARIZE_YOUTUBE_SLIDES_URLS.split(',').map((value) => value.trim())
    : []
const youtubeSlidesTestUrls =
  youtubeSlidesEnvUrls.filter((value) => value.length > 0).length > 0
    ? youtubeSlidesEnvUrls.filter((value) => value.length > 0)
    : defaultYouTubeSlidesUrls
const SLIDES_MAX = 4

type BrowserType = 'chromium' | 'firefox'

test.skip(
  ({ browserName }) => browserName === 'firefox' && !allowFirefoxExtensionTests,
  'Firefox extension tests are blocked by Playwright limitations. Set ALLOW_FIREFOX_EXTENSION_TESTS=1 to run.'
)

type ExtensionHarness = {
  context: BrowserContext
  extensionId: string
  pageErrors: Error[]
  consoleErrors: string[]
  userDataDir: string
  browser: BrowserType
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
    slidesParallel: boolean
    slidesOcrEnabled: boolean
    slidesLayout?: 'strip' | 'gallery'
    model: string
    length: string
    tokenPresent: boolean
  }
  status: string
}

const defaultUiState: UiState = {
  panelOpen: true,
  daemon: { ok: true, authed: true },
  tab: { id: null, url: null, title: null },
  media: null,
  stats: { pageWords: null, videoDurationSeconds: null },
  settings: {
    autoSummarize: true,
    hoverSummaries: false,
    chatEnabled: true,
    automationEnabled: false,
    slidesEnabled: false,
    slidesParallel: true,
    slidesOcrEnabled: false,
    slidesLayout: 'strip',
    model: 'auto',
    length: 'xl',
    tokenPresent: true,
  },
  status: '',
}

function buildUiState(overrides: Partial<UiState>): UiState {
  return {
    ...defaultUiState,
    ...overrides,
    daemon: { ...defaultUiState.daemon, ...overrides.daemon },
    tab: { ...defaultUiState.tab, ...overrides.tab },
    settings: { ...defaultUiState.settings, ...overrides.settings },
  }
}

function buildAssistant(text: string) {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }],
    timestamp: Date.now(),
    api: 'openai-completions',
    provider: 'openai',
    model: 'test',
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: 'stop',
  }
}

function buildAgentStream(text: string) {
  const assistant = buildAssistant(text)
  return [
    'event: chunk',
    `data: ${JSON.stringify({ text })}`,
    '',
    'event: assistant',
    `data: ${JSON.stringify(assistant)}`,
    '',
    'event: done',
    'data: {}',
    '',
  ].join('\n')
}

function filterAllowed(errors: string[]) {
  return errors.filter((message) => !consoleErrorAllowlist.some((pattern) => pattern.test(message)))
}

function trackErrors(page: Page, pageErrors: Error[], consoleErrors: string[]) {
  page.on('pageerror', (error) => pageErrors.push(error))
  page.on('console', (message) => {
    if (message.type() !== 'error') return
    consoleErrors.push(message.text())
  })
}

function assertNoErrors(harness: ExtensionHarness) {
  expect(harness.pageErrors.map((error) => error.message)).toEqual([])
  expect(filterAllowed(harness.consoleErrors)).toEqual([])
}

function getOpenPickerList(page: Page) {
  return page.locator('#summarize-overlay-root .pickerContent:not([hidden]) .pickerList')
}

const showUi = process.env.SHOW_UI === '1'

async function maybeBringToFront(page: Page) {
  // On macOS, `page.bringToFront()` will un-minimize/focus the window even when we launch "hidden".
  // Keep UI quiet by default; set SHOW_UI=1 when debugging.
  if (!showUi) return
  await page.bringToFront()
}

function getExtensionPath(browser: BrowserType): string {
  const outputDir = browser === 'firefox' ? 'firefox-mv3' : 'chrome-mv3'
  return path.resolve(__dirname, '..', '.output', outputDir)
}

function getExtensionUrlScheme(browser: BrowserType): string {
  return browser === 'firefox' ? 'moz-extension' : 'chrome-extension'
}

function getExtensionUrl(harness: ExtensionHarness, pathname: string): string {
  const scheme = getExtensionUrlScheme(harness.browser)
  return `${scheme}://${harness.extensionId}/${pathname}`
}

function getBrowserFromProject(projectName: string): BrowserType {
  return projectName === 'firefox' ? 'firefox' : 'chromium'
}

async function launchExtension(browser: BrowserType = 'chromium'): Promise<ExtensionHarness> {
  const extensionPath = getExtensionPath(browser)

  if (!fs.existsSync(extensionPath)) {
    const buildCmd =
      browser === 'firefox'
        ? 'pnpm -C apps/chrome-extension build:firefox'
        : 'pnpm -C apps/chrome-extension build'
    throw new Error(`Missing built extension. Run: ${buildCmd}`)
  }

  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'summarize-ext-'))
  // MV3 service workers are not reliably supported in headless mode.
  // Default: keep UI out of the way; set SHOW_UI=1 for debugging.
  const showUi = process.env.SHOW_UI === '1'
  const hideUi = !showUi

  const browserType = browser === 'firefox' ? firefox : chromium
  const args = [
    ...(hideUi
      ? ['--start-minimized', '--window-position=-10000,-10000', '--window-size=10,10']
      : []),
    `--disable-extensions-except=${extensionPath}`,
    `--load-extension=${extensionPath}`,
  ]

  const context = await browserType.launchPersistentContext(userDataDir, {
    headless: false,
    args,
  })
  await context.route('**/favicon.ico', async (route) => {
    await route.fulfill({ status: 204, body: '' })
  })
  await context.route('http://127.0.0.1:8787/v1/agent/history', async (route) => {
    await route.fulfill({
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ok: true, messages: null }),
    })
  })

  // Get extension ID - different approach for Firefox vs Chromium
  let extensionId: string

  if (browser === 'firefox') {
    // Firefox: Playwright doesn't expose serviceworker event reliably
    // Solution: Read the explicit ID from manifest.json
    // (wxt.config.ts sets browser_specific_settings.gecko.id for Firefox builds)
    const manifestPath = path.join(extensionPath, 'manifest.json')
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))

    extensionId =
      manifest.browser_specific_settings?.gecko?.id || manifest.applications?.gecko?.id || ''

    if (!extensionId) {
      throw new Error(
        'Firefox extension missing explicit ID in manifest. ' +
          'This should be set via browser_specific_settings.gecko.id in wxt.config.ts'
      )
    }
  } else {
    // Chromium: Use service worker detection
    const background =
      context.serviceWorkers()[0] ??
      (await context.waitForEvent('serviceworker', { timeout: 15_000 }))
    extensionId = new URL(background.url()).host
  }

  return {
    context,
    extensionId,
    pageErrors: [],
    consoleErrors: [],
    userDataDir,
    browser,
  }
}

async function getBackground(harness: ExtensionHarness): Promise<Worker> {
  return (
    harness.context.serviceWorkers()[0] ??
    (await harness.context.waitForEvent('serviceworker', { timeout: 15_000 }))
  )
}

async function sendBgMessage(harness: ExtensionHarness, message: object) {
  const background = await getBackground(harness)
  await expect
    .poll(async () => {
      return await background.evaluate(() => {
        const ports = (
          globalThis as typeof globalThis & {
            __summarizePanelPorts?: Map<number, { postMessage: (msg: object) => void }>
          }
        ).__summarizePanelPorts
        return Boolean(ports && ports.size > 0)
      })
    })
    .toBe(true)
  await background.evaluate((payload) => {
    const global = globalThis as typeof globalThis & {
      __summarizePanelPorts?: Map<number, { postMessage: (msg: object) => void }>
    }
    const ports = global.__summarizePanelPorts
    if (ports && ports.size > 0) {
      const first = ports.values().next().value
      if (first?.postMessage) {
        first.postMessage(payload)
        return
      }
    }
    chrome.runtime.sendMessage(payload)
  }, message)
}

async function sendPanelMessage(page: Page, message: object) {
  await page.waitForFunction(
    () =>
      typeof (window as { __summarizePanelPort?: { postMessage?: unknown } }).__summarizePanelPort
        ?.postMessage === 'function',
    null,
    { timeout: 5_000 }
  )
  await page.evaluate((payload) => {
    const port = (
      window as {
        __summarizePanelPort?: { postMessage: (payload: object) => void }
      }
    ).__summarizePanelPort
    if (!port) throw new Error('Missing panel port')
    port.postMessage(payload)
  }, message)
}

async function waitForPanelPort(page: Page) {
  await page.waitForFunction(
    () =>
      typeof (window as { __summarizePanelPort?: { postMessage?: unknown } }).__summarizePanelPort
        ?.postMessage === 'function',
    null,
    { timeout: 5_000 }
  )
}

async function injectContentScript(harness: ExtensionHarness, file: string, urlPrefix?: string) {
  const background = await getBackground(harness)
  const result = await Promise.race([
    background.evaluate(
      async ({ scriptFile, prefix }) => {
        const tabs = await chrome.tabs.query({})
        const target =
          prefix && prefix.length > 0
            ? tabs.find((tab) => tab.url?.startsWith(prefix))
            : (tabs.find((tab) => tab.active) ?? tabs[0])
        if (!target?.id) return { ok: false, error: 'missing tab' }
        await chrome.scripting.executeScript({
          target: { tabId: target.id },
          files: [scriptFile],
        })
        return { ok: true }
      },
      { scriptFile: file, prefix: urlPrefix ?? '' }
    ),
    new Promise<{ ok: false; error: string }>((resolve) =>
      setTimeout(() => resolve({ ok: false, error: 'inject timeout' }), 5_000)
    ),
  ])

  if (!result?.ok) {
    throw new Error(`Failed to inject ${file}: ${result?.error ?? 'unknown error'}`)
  }
}

async function waitForExtractReady(harness: ExtensionHarness, urlPrefix: string, maxChars = 1200) {
  const background = await getBackground(harness)
  await expect
    .poll(async () => {
      return await background.evaluate(
        async ({ prefix, limit }) => {
          const tabs = await chrome.tabs.query({})
          const target = tabs.find((tab) => tab.url?.startsWith(prefix))
          if (!target?.id) return false
          try {
            const res = (await chrome.tabs.sendMessage(target.id, {
              type: 'extract',
              maxChars: limit,
            })) as { ok?: boolean }
            return Boolean(res?.ok)
          } catch {
            return false
          }
        },
        { prefix: urlPrefix, limit: maxChars }
      )
    })
    .toBe(true)
}

async function mockDaemonSummarize(harness: ExtensionHarness) {
  const background = await getBackground(harness)
  await background.evaluate(() => {
    const originalFetch =
      (globalThis.__originalFetch as typeof globalThis.fetch | undefined) ?? globalThis.fetch
    globalThis.__originalFetch = originalFetch
    if (typeof globalThis.__summarizeCalls !== 'number') {
      globalThis.__summarizeCalls = 0
    }
    if (typeof globalThis.__summarizeRunCount !== 'number') {
      globalThis.__summarizeRunCount = 0
    }
    globalThis.__summarizeLastBody = null
    globalThis.__summarizeBodies = []
    globalThis.__summarizeCallTimes = []
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (url === 'http://127.0.0.1:8787/health') {
        return new Response('', { status: 200 })
      }
      if (url === 'http://127.0.0.1:8787/v1/ping') {
        return new Response('', { status: 200 })
      }
      if (url === 'http://127.0.0.1:8787/v1/summarize') {
        globalThis.__summarizeCalls += 1
        globalThis.__summarizeCallTimes.push(Date.now())
        const body = typeof init?.body === 'string' ? init.body : null
        let parsed: Record<string, unknown> | null = null
        if (body) {
          try {
            parsed = JSON.parse(body) as Record<string, unknown>
            globalThis.__summarizeLastBody = parsed
            globalThis.__summarizeBodies.push(parsed)
          } catch {
            globalThis.__summarizeLastBody = null
          }
        }
        if (parsed?.extractOnly) {
          return new Response(
            JSON.stringify({
              ok: true,
              extracted: {
                url: typeof parsed.url === 'string' ? parsed.url : '',
                title: typeof parsed.title === 'string' ? parsed.title : null,
                content: 'Transcript text from extract-only request.',
                truncated: false,
                mediaDurationSeconds: 120,
                transcriptTimedText: null,
              },
            }),
            { status: 200, headers: { 'content-type': 'application/json' } }
          )
        }
        globalThis.__summarizeRunCount += 1
        return new Response(
          JSON.stringify({ ok: true, id: `run-${globalThis.__summarizeRunCount}` }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }
        )
      }
      return originalFetch(input, init)
    }
  })
}

async function getSummarizeCalls(harness: ExtensionHarness) {
  const background =
    harness.context.serviceWorkers()[0] ??
    (await harness.context.waitForEvent('serviceworker', { timeout: 15_000 }))
  return background.evaluate(() => (globalThis.__summarizeCalls as number | undefined) ?? 0)
}

async function getSummarizeCallTimes(harness: ExtensionHarness) {
  const background =
    harness.context.serviceWorkers()[0] ??
    (await harness.context.waitForEvent('serviceworker', { timeout: 15_000 }))
  return background.evaluate(() => (globalThis.__summarizeCallTimes as number[] | undefined) ?? [])
}

async function getSummarizeLastBody(harness: ExtensionHarness) {
  const background =
    harness.context.serviceWorkers()[0] ??
    (await harness.context.waitForEvent('serviceworker', { timeout: 15_000 }))
  return background.evaluate(() => globalThis.__summarizeLastBody ?? null)
}

async function getSummarizeBodies(harness: ExtensionHarness) {
  const background =
    harness.context.serviceWorkers()[0] ??
    (await harness.context.waitForEvent('serviceworker', { timeout: 15_000 }))
  return background.evaluate(() => (globalThis.__summarizeBodies as unknown[] | undefined) ?? [])
}

async function seedSettings(harness: ExtensionHarness, settings: Record<string, unknown>) {
  const background =
    harness.context.serviceWorkers()[0] ??
    (await harness.context.waitForEvent('serviceworker', { timeout: 15_000 }))
  await background.evaluate(async (payload) => {
    await new Promise<void>((resolve) => {
      chrome.storage.local.set({ settings: payload }, () => resolve())
    })
  }, settings)
}

async function updateSettings(page: Page, patch: Record<string, unknown>) {
  await page.evaluate(async (nextSettings) => {
    const current = await new Promise<Record<string, unknown>>((resolve) => {
      chrome.storage.local.get('settings', (result) => {
        resolve((result?.settings as Record<string, unknown>) ?? {})
      })
    })
    const merged = { ...current, ...nextSettings }
    await new Promise<void>((resolve) => {
      chrome.storage.local.set({ settings: merged }, () => resolve())
    })
  }, patch)
}

async function getSettings(harness: ExtensionHarness) {
  const background =
    harness.context.serviceWorkers()[0] ??
    (await harness.context.waitForEvent('serviceworker', { timeout: 15_000 }))
  return background.evaluate(async () => {
    return await new Promise<Record<string, unknown>>((resolve) => {
      chrome.storage.local.get('settings', (result) => {
        resolve((result?.settings as Record<string, unknown>) ?? {})
      })
    })
  })
}

async function getActiveTabUrl(harness: ExtensionHarness) {
  const background =
    harness.context.serviceWorkers()[0] ??
    (await harness.context.waitForEvent('serviceworker', { timeout: 15_000 }))
  return background.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
    return tab?.url ?? null
  })
}

async function getActiveTabId(harness: ExtensionHarness) {
  const background =
    harness.context.serviceWorkers()[0] ??
    (await harness.context.waitForEvent('serviceworker', { timeout: 15_000 }))
  return background.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
    return tab?.id ?? null
  })
}

async function waitForActiveTabUrl(harness: ExtensionHarness, expectedPrefix: string) {
  await expect.poll(async () => (await getActiveTabUrl(harness)) ?? '').toContain(expectedPrefix)
}

async function activateTabByUrl(harness: ExtensionHarness, expectedPrefix: string) {
  const background =
    harness.context.serviceWorkers()[0] ??
    (await harness.context.waitForEvent('serviceworker', { timeout: 15_000 }))
  await background.evaluate(async (prefix) => {
    const tabs = await chrome.tabs.query({ currentWindow: true })
    const target = tabs.find((tab) => tab.url?.startsWith(prefix))
    if (!target?.id) return
    await chrome.tabs.update(target.id, { active: true })
  }, expectedPrefix)
}

async function openExtensionPage(
  harness: ExtensionHarness,
  pathname: string,
  readySelector: string,
  initScript?: () => void
) {
  const page = await harness.context.newPage()
  trackErrors(page, harness.pageErrors, harness.consoleErrors)
  if (initScript) {
    await page.addInitScript(initScript)
  }
  await page.goto(getExtensionUrl(harness, pathname), {
    waitUntil: 'domcontentloaded',
  })
  await page.waitForSelector(readySelector)
  return page
}

async function closeExtension(context: BrowserContext, userDataDir: string) {
  await context.close()
  fs.rmSync(userDataDir, { recursive: true, force: true })
}

const DAEMON_PORT = 8787
const DEFAULT_DAEMON_TOKEN = 'test-token'
const BLOCKED_ENV_KEYS = [
  'ANTHROPIC_API_KEY',
  'GEMINI_API_KEY',
  'OPENAI_API_KEY',
  'OPENROUTER_API_KEY',
  'XAI_API_KEY',
  'Z_AI_API_KEY',
  'FAL_KEY',
]

function hasFfmpeg(): boolean {
  const result = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' })
  return result.status === 0
}

function hasYtDlp(): boolean {
  const result = spawnSync('yt-dlp', ['--version'], { stdio: 'ignore' })
  return result.status === 0
}

async function isPortInUse(port: number): Promise<boolean> {
  return await new Promise((resolve) => {
    const server = createNetServer()
    server.once('error', (err) => {
      const code = (err as NodeJS.ErrnoException).code
      resolve(code === 'EADDRINUSE' || code === 'EACCES')
    })
    server.once('listening', () => {
      server.close(() => resolve(false))
    })
    server.listen(port, '127.0.0.1')
  })
}

function createSampleVideo(outputPath: string) {
  const args = [
    '-y',
    '-hide_banner',
    '-loglevel',
    'error',
    '-f',
    'lavfi',
    '-i',
    'color=c=red:s=640x360:d=2',
    '-f',
    'lavfi',
    '-i',
    'color=c=blue:s=640x360:d=2',
    '-f',
    'lavfi',
    '-i',
    'color=c=green:s=640x360:d=2',
    '-filter_complex',
    '[0:v][1:v][2:v]concat=n=3:v=1:a=0,format=yuv420p',
    '-movflags',
    'faststart',
    outputPath,
  ]
  const result = spawnSync('ffmpeg', args, { stdio: 'pipe' })
  if (result.status === 0) return
  const detail = result.stderr ? result.stderr.toString().trim() : 'ffmpeg failed'
  throw new Error(`ffmpeg failed: ${detail}`)
}

async function waitForSlidesSnapshot(
  runId: string,
  token: string,
  timeoutMs = 60_000
): Promise<{ slides: Array<unknown> }> {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 5000)
    try {
      const res = await fetch(`http://127.0.0.1:8787/v1/summarize/${runId}/slides`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: controller.signal,
      })
      if (res.ok) {
        const json = (await res.json()) as { ok?: boolean; slides?: { slides?: Array<unknown> } }
        if (json?.ok && json.slides?.slides && json.slides.slides.length > 0) {
          return json.slides
        }
      }
    } catch {
      // ignore and retry
    } finally {
      clearTimeout(timer)
    }
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }
  throw new Error('Timed out waiting for slides snapshot')
}

async function startDaemonSlidesRun(url: string, token: string): Promise<string> {
  const res = await fetch('http://127.0.0.1:8787/v1/summarize', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      url,
      mode: 'url',
      videoMode: 'transcript',
      slides: true,
      slidesOcr: true,
      timestamps: true,
      maxCharacters: null,
    }),
  })
  const json = (await res.json()) as { ok?: boolean; id?: string; error?: string }
  if (!res.ok || !json.ok || !json.id) {
    throw new Error(json.error || `${res.status} ${res.statusText}`)
  }
  return json.id
}

function readDaemonToken(): string | null {
  const envToken =
    typeof process.env.SUMMARIZE_DAEMON_TOKEN === 'string'
      ? process.env.SUMMARIZE_DAEMON_TOKEN.trim()
      : ''
  if (envToken) return envToken
  try {
    const raw = fs.readFileSync(path.join(os.homedir(), '.summarize', 'daemon.json'), 'utf8')
    const json = JSON.parse(raw) as { token?: unknown }
    const token = typeof json.token === 'string' ? json.token.trim() : ''
    return token || null
  } catch {
    return null
  }
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

function tokenizeForOverlap(value: string): Set<string> {
  const cleaned = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 2)
  return new Set(cleaned)
}

function overlapRatio(a: string, b: string): number {
  const aTokens = tokenizeForOverlap(a)
  const bTokens = tokenizeForOverlap(b)
  if (aTokens.size === 0 || bTokens.size === 0) return 0
  let intersection = 0
  for (const token of aTokens) {
    if (bTokens.has(token)) intersection += 1
  }
  return intersection / Math.min(aTokens.size, bTokens.size)
}

const SLIDE_CUSTOM_LENGTH_PATTERN = /^(?<value>\d+(?:\.\d+)?)(?<unit>k|m)?$/i

function resolveSlidesLengthArg(
  lengthValue: string
): { kind: 'preset'; preset: SummaryLength } | { kind: 'chars'; maxCharacters: number } {
  const normalized = lengthValue.trim().toLowerCase()
  if (Object.hasOwn(SUMMARY_LENGTH_SPECS, normalized)) {
    return { kind: 'preset', preset: normalized as SummaryLength }
  }
  const match = normalized.match(SLIDE_CUSTOM_LENGTH_PATTERN)
  if (!match) return { kind: 'preset', preset: 'short' }
  const value = Number(match.groups?.value ?? match[1])
  if (!Number.isFinite(value) || value <= 0) {
    return { kind: 'preset', preset: 'short' }
  }
  const unit = (match.groups?.unit ?? '').toLowerCase()
  const multiplier = unit === 'm' ? 1_000_000 : unit === 'k' ? 1_000 : 1
  return { kind: 'chars', maxCharacters: Math.round(value * multiplier) }
}

function parseSlidesFromSummary(markdown: string): Array<{ index: number; text: string }> {
  const summaries = parseSlideSummariesFromMarkdown(markdown)
  if (summaries.size === 0) return []
  const total = summaries.size
  const entries: Array<{ index: number; text: string }> = []
  for (const [index, text] of summaries.entries()) {
    const parsed = splitSlideTitleFromText({ text, slideIndex: index, total })
    const body = normalizeWhitespace(parsed.body ?? '')
    entries.push({ index, text: body })
  }
  entries.sort((a, b) => a.index - b.index)
  return entries
}

function runCliSummary(url: string, args: string[]): string {
  const env = { ...process.env, NO_COLOR: '1' }
  delete env.FORCE_COLOR
  const result = spawnSync('pnpm', ['-s', 'summarize', '--', ...args, url], {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 50 * 1024 * 1024,
    env,
  })
  if (result.status !== 0) {
    const stderr = result.stderr ? result.stderr.toString().trim() : ''
    const stdout = result.stdout ? result.stdout.toString().trim() : ''
    throw new Error(`CLI summarize failed (${result.status}): ${stderr || stdout}`)
  }
  const output = result.stdout?.toString().trim() ?? ''
  if (!output) {
    throw new Error('CLI summarize returned empty output')
  }
  const parsed = JSON.parse(output) as { summary?: string | null }
  if (!parsed.summary) {
    throw new Error('CLI summarize JSON missing summary')
  }
  return parsed.summary
}

async function startDaemonSummaryRun({
  url,
  token,
  length,
  slides,
  slidesMax,
}: {
  url: string
  token: string
  length: string
  slides: boolean
  slidesMax?: number
}): Promise<string> {
  const res = await fetch('http://127.0.0.1:8787/v1/summarize', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      url,
      mode: 'url',
      videoMode: 'transcript',
      timestamps: true,
      length,
      model: 'auto',
      ...(slides
        ? {
            slides: true,
            slidesOcr: true,
            ...(typeof slidesMax === 'number' && Number.isFinite(slidesMax) ? { slidesMax } : {}),
          }
        : {}),
      maxCharacters: null,
    }),
  })
  const json = (await res.json()) as { ok?: boolean; id?: string; error?: string }
  if (!res.ok || !json.ok || !json.id) {
    throw new Error(json.error || `${res.status} ${res.statusText}`)
  }
  return json.id
}

async function getPanelPhase(page: Page): Promise<string | null> {
  return await page.evaluate(() => {
    const hooks = (
      window as typeof globalThis & {
        __summarizeTestHooks?: { getPhase?: () => string }
      }
    ).__summarizeTestHooks
    return hooks?.getPhase?.() ?? null
  })
}

async function getPanelSummaryMarkdown(page: Page): Promise<string> {
  return await page.evaluate(() => {
    const hooks = (
      window as typeof globalThis & {
        __summarizeTestHooks?: { getSummaryMarkdown?: () => string }
      }
    ).__summarizeTestHooks
    return hooks?.getSummaryMarkdown?.() ?? ''
  })
}

async function getPanelModel(page: Page): Promise<string | null> {
  return await page.evaluate(() => {
    const hooks = (
      window as typeof globalThis & {
        __summarizeTestHooks?: { getModel?: () => string | null }
      }
    ).__summarizeTestHooks
    return hooks?.getModel?.() ?? null
  })
}

async function getPanelSlidesTimeline(
  page: Page
): Promise<Array<{ index: number; timestamp: number | null }>> {
  return await page.evaluate(() => {
    const hooks = (
      window as typeof globalThis & {
        __summarizeTestHooks?: {
          getSlidesTimeline?: () => Array<{ index: number; timestamp: number | null }>
        }
      }
    ).__summarizeTestHooks
    return hooks?.getSlidesTimeline?.() ?? []
  })
}

async function getPanelTranscriptTimedText(page: Page): Promise<string | null> {
  return await page.evaluate(() => {
    const hooks = (
      window as typeof globalThis & {
        __summarizeTestHooks?: { getTranscriptTimedText?: () => string | null }
      }
    ).__summarizeTestHooks
    return hooks?.getTranscriptTimedText?.() ?? null
  })
}

async function getPanelSlidesSummaryMarkdown(page: Page): Promise<string> {
  return await page.evaluate(() => {
    const hooks = (
      window as typeof globalThis & {
        __summarizeTestHooks?: { getSlidesSummaryMarkdown?: () => string }
      }
    ).__summarizeTestHooks
    return hooks?.getSlidesSummaryMarkdown?.() ?? ''
  })
}

async function getPanelSlidesSummaryComplete(page: Page): Promise<boolean> {
  return await page.evaluate(() => {
    const hooks = (
      window as typeof globalThis & {
        __summarizeTestHooks?: { getSlidesSummaryComplete?: () => boolean }
      }
    ).__summarizeTestHooks
    return hooks?.getSlidesSummaryComplete?.() ?? false
  })
}

async function getPanelSlidesSummaryModel(page: Page): Promise<string | null> {
  return await page.evaluate(() => {
    const hooks = (
      window as typeof globalThis & {
        __summarizeTestHooks?: { getSlidesSummaryModel?: () => string | null }
      }
    ).__summarizeTestHooks
    return hooks?.getSlidesSummaryModel?.() ?? null
  })
}

async function getPanelSlideDescriptions(page: Page): Promise<Array<[number, string]>> {
  return await page.evaluate(() => {
    const hooks = (
      window as typeof globalThis & {
        __summarizeTestHooks?: { getSlideDescriptions?: () => Array<[number, string]> }
      }
    ).__summarizeTestHooks
    return hooks?.getSlideDescriptions?.() ?? []
  })
}

function buildSlidesPayload({
  sourceUrl,
  sourceId,
  count,
  textPrefix,
  sourceKind = 'youtube',
}: {
  sourceUrl: string
  sourceId: string
  count: number
  textPrefix: string
  sourceKind?: string
}) {
  return {
    sourceUrl,
    sourceId,
    sourceKind,
    ocrAvailable: true,
    slides: Array.from({ length: count }, (_, index) => {
      const slideIndex = index + 1
      return {
        index: slideIndex,
        timestamp: index * 10,
        imageUrl: `http://127.0.0.1:8787/v1/slides/${sourceId}/${slideIndex}?v=1`,
        ocrText: `${textPrefix} slide ${slideIndex} has enough OCR text to pass thresholds.`,
      }
    }),
  }
}

test('sidepanel loads without runtime errors', async ({ browserName: _browserName }, testInfo) => {
  const harness = await launchExtension(getBrowserFromProject(testInfo.project.name))

  try {
    await openExtensionPage(harness, 'sidepanel.html', '#title')
    await new Promise((resolve) => setTimeout(resolve, 500))
    assertNoErrors(harness)
  } finally {
    await closeExtension(harness.context, harness.userDataDir)
  }
})

test('sidepanel hides chat dock when chat is disabled', async ({
  browserName: _browserName,
}, testInfo) => {
  const harness = await launchExtension(getBrowserFromProject(testInfo.project.name))

  try {
    await seedSettings(harness, { chatEnabled: false })
    const page = await harness.context.newPage()
    trackErrors(page, harness.pageErrors, harness.consoleErrors)
    await page.addInitScript(() => {
      ;(
        window as typeof globalThis & { __summarizeTestHooks?: Record<string, unknown> }
      ).__summarizeTestHooks = {}
    })
    await page.goto(getExtensionUrl(harness, 'sidepanel.html'), {
      waitUntil: 'domcontentloaded',
    })
    await page.waitForSelector('#title')
    await waitForPanelPort(page)
    await waitForPanelPort(page)
    await expect(page.locator('#chatDock')).toBeHidden()
    await expect(page.locator('#chatContainer')).toBeHidden()
    assertNoErrors(harness)
  } finally {
    await closeExtension(harness.context, harness.userDataDir)
  }
})

test('sidepanel updates chat visibility when settings change', async ({
  browserName: _browserName,
}, testInfo) => {
  const harness = await launchExtension(getBrowserFromProject(testInfo.project.name))

  try {
    await seedSettings(harness, { chatEnabled: true })
    const page = await openExtensionPage(harness, 'sidepanel.html', '#title', () => {
      ;(window as typeof globalThis & { IntersectionObserver?: unknown }).IntersectionObserver =
        undefined
    })
    await expect(page.locator('#chatDock')).toBeVisible()

    await updateSettings(page, { chatEnabled: false })
    await expect(page.locator('#chatDock')).toBeHidden()
    await expect(page.locator('#chatContainer')).toBeHidden()
    assertNoErrors(harness)
  } finally {
    await closeExtension(harness.context, harness.userDataDir)
  }
})

test('sidepanel scheme picker supports keyboard selection', async ({
  browserName: _browserName,
}, testInfo) => {
  const harness = await launchExtension(getBrowserFromProject(testInfo.project.name))

  try {
    const page = await openExtensionPage(harness, 'sidepanel.html', '#title', () => {
      ;(
        window as typeof globalThis & { __summarizeTestHooks?: Record<string, unknown> }
      ).__summarizeTestHooks = {}
    })
    await waitForPanelPort(page)
    await page.click('#drawerToggle')
    await expect(page.locator('#drawer')).toBeVisible()

    const schemeLabel = page.locator('label.scheme')
    const schemeTrigger = schemeLabel.locator('.pickerTrigger')

    await schemeTrigger.focus()
    await schemeTrigger.press('Enter')
    const schemeList = getOpenPickerList(page)
    await expect(schemeList).toBeVisible()
    await schemeList.focus()
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('Enter')

    await expect(schemeTrigger.locator('.scheme-label')).toHaveText('Cedar')
    assertNoErrors(harness)
  } finally {
    await closeExtension(harness.context, harness.userDataDir)
  }
})

test('sidepanel refresh free models from advanced settings', async ({
  browserName: _browserName,
}, testInfo) => {
  const harness = await launchExtension(getBrowserFromProject(testInfo.project.name))

  try {
    await mockDaemonSummarize(harness)
    await seedSettings(harness, { token: 'test-token', autoSummarize: false })

    let modelCalls = 0
    await harness.context.route('http://127.0.0.1:8787/v1/models', async (route) => {
      modelCalls += 1
      await route.fulfill({
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          ok: true,
          options: [
            { id: 'auto', label: 'Auto' },
            { id: 'free', label: 'Free (OpenRouter)' },
          ],
          providers: {
            openrouter: true,
            openai: false,
            google: false,
            anthropic: false,
            xai: false,
            zai: false,
          },
          openaiBaseUrl: null,
          localModelsSource: null,
        }),
      })
    })

    await harness.context.route('http://127.0.0.1:8787/v1/refresh-free', async (route) => {
      await route.fulfill({
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ok: true, id: 'refresh-1' }),
      })
    })

    const sseBody = [
      'event: status',
      'data: {"text":"Refresh free: scanning..."}',
      '',
      'event: done',
      'data: {}',
      '',
    ].join('\n')

    await harness.context.route(
      'http://127.0.0.1:8787/v1/refresh-free/refresh-1/events',
      async (route) => {
        await route.fulfill({
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
          body: sseBody,
        })
      }
    )

    const page = await openExtensionPage(harness, 'sidepanel.html', '#title')
    await waitForPanelPort(page)
    await page.click('#drawerToggle')
    await expect(page.locator('#drawer')).toBeVisible()
    await sendBgMessage(harness, {
      type: 'ui:state',
      state: buildUiState({
        status: '',
        settings: { tokenPresent: true, autoSummarize: false, model: 'free', length: 'xl' },
      }),
    })

    await page.locator('#advancedSettings summary').click()
    await expect(page.locator('#modelRefresh')).toBeVisible()
    await page.locator('#modelRefresh').click()
    await expect(page.locator('#modelStatus')).toContainText('Free models updated.')
    await expect.poll(() => modelCalls).toBeGreaterThanOrEqual(2)
    assertNoErrors(harness)
  } finally {
    await closeExtension(harness.context, harness.userDataDir)
  }
})

test('sidepanel refresh free shows error on failure', async ({
  browserName: _browserName,
}, testInfo) => {
  const harness = await launchExtension(getBrowserFromProject(testInfo.project.name))

  try {
    await mockDaemonSummarize(harness)
    await seedSettings(harness, { token: 'test-token', autoSummarize: false })

    await harness.context.route('http://127.0.0.1:8787/v1/models', async (route) => {
      await route.fulfill({
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          ok: true,
          options: [
            { id: 'auto', label: 'Auto' },
            { id: 'free', label: 'Free (OpenRouter)' },
          ],
          providers: {
            openrouter: true,
            openai: false,
            google: false,
            anthropic: false,
            xai: false,
            zai: false,
          },
          openaiBaseUrl: null,
          localModelsSource: null,
        }),
      })
    })

    await harness.context.route('http://127.0.0.1:8787/v1/refresh-free', async (route) => {
      await route.fulfill({
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ok: false, error: 'nope' }),
      })
    })

    const page = await openExtensionPage(harness, 'sidepanel.html', '#title')
    await page.click('#drawerToggle')
    await expect(page.locator('#drawer')).toBeVisible()
    await sendBgMessage(harness, {
      type: 'ui:state',
      state: buildUiState({
        status: '',
        settings: { tokenPresent: true, autoSummarize: false, model: 'free', length: 'xl' },
      }),
    })

    await page.locator('#advancedSettings summary').click()
    await expect(page.locator('#modelRefresh')).toBeVisible()
    await page.locator('#modelRefresh').click()
    await expect(page.locator('#modelStatus')).toContainText('Refresh free failed')
    await expect(page.locator('#modelStatus')).toHaveAttribute('data-state', 'error')
    assertNoErrors(harness)
  } finally {
    await closeExtension(harness.context, harness.userDataDir)
  }
})

test('sidepanel mode picker updates theme mode', async ({
  browserName: _browserName,
}, testInfo) => {
  const harness = await launchExtension(getBrowserFromProject(testInfo.project.name))

  try {
    const page = await openExtensionPage(harness, 'sidepanel.html', '#title')
    await page.click('#drawerToggle')
    await expect(page.locator('#drawer')).toBeVisible()

    const modeLabel = page.locator('label.mode')
    const modeTrigger = modeLabel.locator('.pickerTrigger')

    await modeTrigger.focus()
    await modeTrigger.press('Enter')
    const modeList = getOpenPickerList(page)
    await expect(modeList).toBeVisible()
    await modeList.focus()
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('Enter')

    await expect(modeTrigger).toHaveText('Dark')
    await expect(page.locator('html')).toHaveAttribute('data-mode', 'dark')
    assertNoErrors(harness)
  } finally {
    await closeExtension(harness.context, harness.userDataDir)
  }
})

test('sidepanel custom length input accepts typing', async ({
  browserName: _browserName,
}, testInfo) => {
  const harness = await launchExtension(getBrowserFromProject(testInfo.project.name))

  try {
    const page = await openExtensionPage(harness, 'sidepanel.html', '#title')
    await page.click('#drawerToggle')
    await expect(page.locator('#drawer')).toBeVisible()

    const lengthLabel = page.locator('label.length.mini')
    const lengthTrigger = lengthLabel.locator('.pickerTrigger').first()

    await lengthTrigger.click()
    const lengthList = getOpenPickerList(page)
    await expect(lengthList).toBeVisible()
    await lengthList.locator('.pickerOption', { hasText: 'Custom…' }).click()

    const customInput = page.locator('#lengthCustom')
    await expect(customInput).toBeVisible()
    await customInput.click()
    await customInput.fill('20k')
    await expect(customInput).toHaveValue('20k')

    assertNoErrors(harness)
  } finally {
    await closeExtension(harness.context, harness.userDataDir)
  }
})

test('sidepanel updates title after stream when tab title changes', async ({
  browserName: _browserName,
}, testInfo) => {
  const harness = await launchExtension(getBrowserFromProject(testInfo.project.name))

  try {
    await mockDaemonSummarize(harness)
    await seedSettings(harness, { token: 'test-token', autoSummarize: false })
    const page = await openExtensionPage(harness, 'sidepanel.html', '#title')
    const sseBody = [
      'event: meta',
      'data: {"model":"test"}',
      '',
      'event: chunk',
      'data: {"text":"Hello world"}',
      '',
      'event: done',
      'data: {}',
      '',
    ].join('\n')

    await harness.context.route(
      /http:\/\/127\.0\.0\.1:8787\/v1\/summarize\/[^/]+\/events/,
      async (route) => {
        await route.fulfill({
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
          body: sseBody,
        })
      }
    )

    await sendBgMessage(harness, {
      type: 'run:start',
      run: {
        id: 'run-1',
        url: 'https://example.com/video',
        title: 'Original Title',
        model: 'auto',
        reason: 'manual',
      },
    })

    await expect(page.locator('#title')).toHaveText('Original Title')
    await expect(page.locator('#render')).toContainText('Hello world')

    await sendBgMessage(harness, {
      type: 'ui:state',
      state: buildUiState({
        tab: { url: 'https://example.com/video', title: 'Updated Title' },
        status: '',
      }),
    })

    await expect(page.locator('#title')).toHaveText('Updated Title')
    assertNoErrors(harness)
  } finally {
    await closeExtension(harness.context, harness.userDataDir)
  }
})

test('sidepanel clears summary when tab url changes', async ({
  browserName: _browserName,
}, testInfo) => {
  const harness = await launchExtension(getBrowserFromProject(testInfo.project.name))

  try {
    await mockDaemonSummarize(harness)
    await seedSettings(harness, { token: 'test-token', autoSummarize: false })
    const page = await openExtensionPage(harness, 'sidepanel.html', '#title')

    await sendBgMessage(harness, {
      type: 'ui:state',
      state: buildUiState({
        tab: { url: 'https://example.com/old', title: 'Old Title' },
        settings: { autoSummarize: false, tokenPresent: true },
        status: '',
      }),
    })

    await expect(page.locator('#title')).toHaveText('Old Title')
    await page.evaluate(() => {
      const host = document.querySelector('.render__markdownHost') as HTMLElement | null
      if (host) host.textContent = 'Hello world'
    })
    await expect(page.locator('.render__markdownHost')).toContainText('Hello world')

    await sendBgMessage(harness, {
      type: 'ui:state',
      state: buildUiState({
        tab: { url: 'https://example.com/new', title: 'New Title' },
        settings: { autoSummarize: false },
        status: '',
      }),
    })

    await expect(page.locator('#title')).toHaveText('New Title')
    await expect(page.locator('.render__markdownHost')).toHaveText('')
    assertNoErrors(harness)
  } finally {
    await closeExtension(harness.context, harness.userDataDir)
  }
})

test('sidepanel restores cached state when switching YouTube tabs', async ({
  browserName: _browserName,
}, testInfo) => {
  const harness = await launchExtension(getBrowserFromProject(testInfo.project.name))

  try {
    await mockDaemonSummarize(harness)
    await seedSettings(harness, {
      token: 'test-token',
      autoSummarize: false,
      slidesEnabled: true,
      slidesOcrEnabled: true,
    })
    const page = await openExtensionPage(harness, 'sidepanel.html', '#title', () => {
      ;(
        window as typeof globalThis & { __summarizeTestHooks?: Record<string, unknown> }
      ).__summarizeTestHooks = {}
    })
    await waitForPanelPort(page)

    const sseBody = (text: string) =>
      ['event: chunk', `data: ${JSON.stringify({ text })}`, '', 'event: done', 'data: {}', ''].join(
        '\n'
      )
    await page.route('http://127.0.0.1:8787/v1/summarize/**/events', async (route) => {
      const url = route.request().url()
      const match = url.match(/summarize\/([^/]+)\/events/)
      const runId = match ? (match[1] ?? '') : ''
      const body = runId === 'run-a' ? sseBody('Summary A') : sseBody('Summary B')
      await route.fulfill({
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
        body,
      })
    })

    const placeholderPng = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO3kq0cAAAAASUVORK5CYII=',
      'base64'
    )
    await page.route('http://127.0.0.1:8787/v1/slides/**', async (route) => {
      await route.fulfill({
        status: 200,
        headers: {
          'content-type': 'image/png',
          'x-summarize-slide-ready': '1',
        },
        body: placeholderPng,
      })
    })

    const tabAState = buildUiState({
      tab: { id: 1, url: 'https://www.youtube.com/watch?v=alpha123', title: 'Alpha Tab' },
      settings: {
        autoSummarize: false,
        slidesEnabled: true,
        slidesOcrEnabled: true,
        tokenPresent: true,
      },
      status: '',
    })
    await sendBgMessage(harness, { type: 'ui:state', state: tabAState })
    await sendBgMessage(harness, {
      type: 'run:start',
      run: {
        id: 'run-a',
        url: 'https://www.youtube.com/watch?v=alpha123',
        title: 'Alpha Tab',
        model: 'auto',
        reason: 'manual',
      },
    })
    await expect(page.locator('#render')).toContainText('Summary A')

    await page.waitForFunction(
      () => {
        const hooks = (
          window as typeof globalThis & {
            __summarizeTestHooks?: { applySlidesPayload?: (payload: unknown) => void }
          }
        ).__summarizeTestHooks
        return Boolean(hooks?.applySlidesPayload)
      },
      null,
      { timeout: 5_000 }
    )
    const slidesPayloadA = {
      sourceUrl: 'https://www.youtube.com/watch?v=alpha123',
      sourceId: 'alpha',
      sourceKind: 'url',
      ocrAvailable: true,
      slides: [
        {
          index: 1,
          timestamp: 0,
          imageUrl: 'http://127.0.0.1:8787/v1/slides/alpha/1?v=1',
          ocrText: 'Alpha slide one.',
        },
        {
          index: 2,
          timestamp: 12,
          imageUrl: 'http://127.0.0.1:8787/v1/slides/alpha/2?v=1',
          ocrText: 'Alpha slide two.',
        },
      ],
    }
    await page.evaluate((payload) => {
      const hooks = (
        window as typeof globalThis & {
          __summarizeTestHooks?: { applySlidesPayload?: (payload: unknown) => void }
        }
      ).__summarizeTestHooks
      hooks?.applySlidesPayload?.(payload)
    }, slidesPayloadA)
    await expect.poll(async () => (await getPanelSlideDescriptions(page)).length).toBe(2)
    const slidesA = await getPanelSlideDescriptions(page)
    expect(slidesA[0]?.[1] ?? '').toContain('Alpha')

    const tabBState = buildUiState({
      tab: { id: 2, url: 'https://www.youtube.com/watch?v=bravo456', title: 'Bravo Tab' },
      settings: {
        autoSummarize: false,
        slidesEnabled: true,
        slidesOcrEnabled: true,
        tokenPresent: true,
      },
      status: '',
    })
    await sendBgMessage(harness, { type: 'ui:state', state: tabBState })
    await expect(page.locator('#title')).toHaveText('Bravo Tab')
    await sendBgMessage(harness, {
      type: 'run:start',
      run: {
        id: 'run-b',
        url: 'https://www.youtube.com/watch?v=bravo456',
        title: 'Bravo Tab',
        model: 'auto',
        reason: 'manual',
      },
    })
    await expect(page.locator('#render')).toContainText('Summary B')

    const slidesPayloadB = {
      sourceUrl: 'https://www.youtube.com/watch?v=bravo456',
      sourceId: 'bravo',
      sourceKind: 'url',
      ocrAvailable: true,
      slides: [
        {
          index: 1,
          timestamp: 0,
          imageUrl: 'http://127.0.0.1:8787/v1/slides/bravo/1?v=1',
          ocrText: 'Bravo slide one.',
        },
      ],
    }
    await page.evaluate((payload) => {
      const hooks = (
        window as typeof globalThis & {
          __summarizeTestHooks?: { applySlidesPayload?: (payload: unknown) => void }
        }
      ).__summarizeTestHooks
      hooks?.applySlidesPayload?.(payload)
    }, slidesPayloadB)
    await expect.poll(async () => (await getPanelSlideDescriptions(page)).length).toBe(1)
    const slidesB = await getPanelSlideDescriptions(page)
    expect(slidesB[0]?.[1] ?? '').toContain('Bravo')

    await sendBgMessage(harness, { type: 'ui:state', state: tabAState })
    await expect(page.locator('#title')).toHaveText('Alpha Tab')
    await expect.poll(async () => await getPanelSummaryMarkdown(page)).toContain('Summary A')
    const restoredSlides = await getPanelSlideDescriptions(page)
    expect(restoredSlides[0]?.[1] ?? '').toContain('Alpha')
    expect(restoredSlides.some((entry) => entry[1].includes('Bravo'))).toBe(false)

    assertNoErrors(harness)
  } finally {
    await closeExtension(harness.context, harness.userDataDir)
  }
})

test('sidepanel auto summarizes quickly when switching YouTube tabs', async ({
  browserName: _browserName,
}, testInfo) => {
  const harness = await launchExtension(getBrowserFromProject(testInfo.project.name))

  try {
    await mockDaemonSummarize(harness)
    await seedSettings(harness, { token: 'test-token', autoSummarize: true, slidesEnabled: false })
    await harness.context.route('https://www.youtube.com/**', async (route) => {
      await route.fulfill({
        status: 200,
        headers: { 'content-type': 'text/html' },
        body: '<html><body><article>YouTube placeholder</article></body></html>',
      })
    })

    const videoA = 'https://www.youtube.com/watch?v=videoA12345'
    const videoB = 'https://www.youtube.com/watch?v=videoB67890'

    const pageA = await harness.context.newPage()
    await pageA.goto(videoA, { waitUntil: 'domcontentloaded' })
    const pageB = await harness.context.newPage()
    await pageB.goto(videoB, { waitUntil: 'domcontentloaded' })

    await activateTabByUrl(harness, videoA)
    await waitForActiveTabUrl(harness, videoA)
    await injectContentScript(harness, 'content-scripts/extract.js', videoA)
    await injectContentScript(harness, 'content-scripts/extract.js', videoB)

    const panel = await openExtensionPage(harness, 'sidepanel.html', '#title')
    await waitForPanelPort(panel)
    await maybeBringToFront(pageA)
    await activateTabByUrl(harness, videoA)
    await waitForActiveTabUrl(harness, videoA)
    await mockDaemonSummarize(harness)

    const sseBody = (text: string) =>
      ['event: chunk', `data: ${JSON.stringify({ text })}`, '', 'event: done', 'data: {}', ''].join(
        '\n'
      )
    await panel.route('http://127.0.0.1:8787/v1/summarize/**/events', async (route) => {
      const url = route.request().url()
      const match = url.match(/summarize\/([^/]+)\/events/)
      const runId = match ? (match[1] ?? '') : ''
      const runIndex = Number.parseInt(runId.replace('run-', ''), 10)
      const summaryText = runIndex % 2 === 1 ? 'Video A summary' : 'Video B summary'
      await route.fulfill({
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
        body: sseBody(summaryText),
      })
    })

    const waitForSummarizeCall = async (sinceCount: number, startedAt: number) => {
      await expect
        .poll(async () => await getSummarizeCalls(harness), { timeout: 5_000 })
        .toBeGreaterThan(sinceCount)
      const callTimes = await getSummarizeCallTimes(harness)
      const callTime = callTimes[sinceCount] ?? callTimes.at(-1) ?? Date.now()
      expect(callTime - startedAt).toBeLessThan(4_000)
    }

    const callsBeforeReady = await getSummarizeCalls(harness)
    const startA = Date.now()
    await sendPanelMessage(panel, { type: 'panel:ready' })
    await waitForSummarizeCall(callsBeforeReady, startA)
    await expect
      .poll(async () => {
        const bodies = (await getSummarizeBodies(harness)) as Array<Record<string, unknown>>
        return bodies.some((body) => body?.url === videoA)
      })
      .toBe(true)

    const callsBeforeB = await getSummarizeCalls(harness)
    const startB = Date.now()
    await activateTabByUrl(harness, videoB)
    await waitForActiveTabUrl(harness, videoB)
    await waitForSummarizeCall(callsBeforeB, startB)
    await expect
      .poll(async () => {
        const bodies = (await getSummarizeBodies(harness)) as Array<Record<string, unknown>>
        return bodies.some((body) => body?.url === videoB)
      })
      .toBe(true)

    const callsBeforeReturn = await getSummarizeCalls(harness)
    const startA2 = Date.now()
    await activateTabByUrl(harness, videoA)
    await waitForActiveTabUrl(harness, videoA)

    const callsAfterReturn = await getSummarizeCalls(harness)
    if (callsAfterReturn > callsBeforeReturn) {
      const callTimes = await getSummarizeCallTimes(harness)
      const callTime = callTimes[callsAfterReturn - 1] ?? callTimes.at(-1) ?? Date.now()
      expect(callTime - startA2).toBeLessThan(4_000)
    }

    assertNoErrors(harness)
  } finally {
    await closeExtension(harness.context, harness.userDataDir)
  }
})

test('sidepanel resumes slides when returning to a tab', async ({
  browserName: _browserName,
}, testInfo) => {
  const harness = await launchExtension(getBrowserFromProject(testInfo.project.name))

  try {
    await seedSettings(harness, {
      token: 'test-token',
      autoSummarize: false,
      slidesEnabled: true,
      slidesParallel: true,
      slidesOcrEnabled: true,
    })
    const page = await openExtensionPage(harness, 'sidepanel.html', '#title', () => {
      ;(
        window as typeof globalThis & { __summarizeTestHooks?: Record<string, unknown> }
      ).__summarizeTestHooks = {}
    })
    await waitForPanelPort(page)

    const slidesPayload = {
      sourceUrl: 'https://www.youtube.com/watch?v=abc123',
      sourceId: 'alpha',
      sourceKind: 'youtube',
      ocrAvailable: true,
      slides: [
        {
          index: 1,
          timestamp: 0,
          imageUrl: 'http://127.0.0.1:8787/v1/slides/alpha/1?v=1',
          ocrText: 'Alpha slide one.',
        },
      ],
    }
    await page.route('http://127.0.0.1:8787/v1/summarize/**/slides', async (route) => {
      await route.fulfill({
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ok: true, slides: slidesPayload }),
      })
    })

    const slidesStreamBody = [
      'event: slides',
      `data: ${JSON.stringify(slidesPayload)}`,
      '',
      'event: done',
      'data: {}',
      '',
    ].join('\n')
    await page.route('http://127.0.0.1:8787/v1/summarize/slides-a/slides/events', async (route) => {
      await route.fulfill({
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
        body: slidesStreamBody,
      })
    })
    await page.route('http://127.0.0.1:8787/v1/summarize/slides-a/events', async (route) => {
      await route.fulfill({
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
        body: ['event: done', 'data: {}', ''].join('\n'),
      })
    })

    const placeholderPng = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO3kq0cAAAAASUVORK5CYII=',
      'base64'
    )
    await page.route('http://127.0.0.1:8787/v1/slides/**', async (route) => {
      await route.fulfill({
        status: 200,
        headers: {
          'content-type': 'image/png',
          'x-summarize-slide-ready': '1',
        },
        body: placeholderPng,
      })
    })

    const tabAState = buildUiState({
      tab: { id: 1, url: 'https://www.youtube.com/watch?v=abc123', title: 'Alpha Video' },
      media: { hasVideo: true, hasAudio: true, hasCaptions: true },
      settings: {
        autoSummarize: false,
        slidesEnabled: true,
        slidesParallel: true,
        slidesOcrEnabled: true,
        tokenPresent: true,
      },
    })
    const tabBState = buildUiState({
      tab: { id: 2, url: 'https://example.com', title: 'Bravo Tab' },
      media: { hasVideo: false, hasAudio: false, hasCaptions: false },
      settings: {
        autoSummarize: false,
        slidesEnabled: true,
        slidesParallel: true,
        slidesOcrEnabled: true,
        tokenPresent: true,
      },
    })

    await sendBgMessage(harness, { type: 'ui:state', state: tabAState })
    await sendBgMessage(harness, { type: 'ui:state', state: tabBState })
    await expect(page.locator('#title')).toHaveText('Bravo Tab')
    await sendBgMessage(harness, {
      type: 'slides:run',
      ok: true,
      runId: 'slides-a',
      url: 'https://www.youtube.com/watch?v=abc123',
    })
    await sendBgMessage(harness, { type: 'ui:state', state: tabAState })
    await expect(page.locator('#title')).toHaveText('Alpha Video')

    await expect.poll(async () => (await getPanelSlideDescriptions(page)).length).toBe(1)
    const slides = await getPanelSlideDescriptions(page)
    expect(slides[0]?.[1] ?? '').toContain('Alpha')

    assertNoErrors(harness)
  } finally {
    await closeExtension(harness.context, harness.userDataDir)
  }
})

test('sidepanel switches between page, video, and slides modes', async ({
  browserName: _browserName,
}, testInfo) => {
  const harness = await launchExtension(getBrowserFromProject(testInfo.project.name))

  try {
    await seedSettings(harness, {
      token: 'test-token',
      autoSummarize: false,
      slidesEnabled: false,
      slidesLayout: 'gallery',
      slidesOcrEnabled: true,
    })
    const page = await openExtensionPage(harness, 'sidepanel.html', '#title', () => {
      ;(
        window as typeof globalThis & { __summarizeTestHooks?: Record<string, unknown> }
      ).__summarizeTestHooks = {}
    })
    await waitForPanelPort(page)

    await page.route('http://127.0.0.1:8787/v1/tools', async (route) => {
      await route.fulfill({
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          ok: true,
          tools: {
            ytDlp: { available: true },
            ffmpeg: { available: true },
            tesseract: { available: true },
          },
        }),
      })
    })

    const sseBody = (text: string) =>
      ['event: chunk', `data: ${JSON.stringify({ text })}`, '', 'event: done', 'data: {}', ''].join(
        '\n'
      )
    await page.route('http://127.0.0.1:8787/v1/summarize/**/events', async (route) => {
      const url = route.request().url()
      const match = url.match(/summarize\/([^/]+)\/events/)
      const runId = match ? (match[1] ?? '') : ''
      const text =
        runId === 'run-page'
          ? 'Page summary'
          : runId === 'run-video'
            ? 'Video summary'
            : runId === 'run-slides'
              ? 'Slides summary'
              : 'Back summary'
      await route.fulfill({
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
        body: sseBody(text),
      })
    })
    const waitForRunEvents = (runId: string) =>
      page.waitForResponse(
        (response) =>
          response.url().includes(`/v1/summarize/${runId}/events`) && response.status() === 200,
        { timeout: 10_000 }
      )

    const placeholderPng = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO3kq0cAAAAASUVORK5CYII=',
      'base64'
    )
    await page.route('http://127.0.0.1:8787/v1/slides/**', async (route) => {
      await route.fulfill({
        status: 200,
        headers: {
          'content-type': 'image/png',
          'x-summarize-slide-ready': '1',
        },
        body: placeholderPng,
      })
    })

    const uiState = buildUiState({
      tab: { id: 1, url: 'https://example.com/video', title: 'Example Video' },
      media: { hasVideo: true, hasAudio: true, hasCaptions: false },
      stats: { pageWords: 120, videoDurationSeconds: 120 },
      settings: {
        autoSummarize: false,
        slidesEnabled: false,
        slidesParallel: true,
        slidesLayout: 'gallery',
        slidesOcrEnabled: true,
        tokenPresent: true,
      },
      status: '',
    })
    const summarizeButton = page.locator('.summarizeButton')
    await expect(summarizeButton).toBeVisible()

    await page.waitForFunction(
      () => {
        const hooks = (
          window as typeof globalThis & { __summarizeTestHooks?: { setSummarizeMode?: unknown } }
        ).__summarizeTestHooks
        return typeof hooks?.setSummarizeMode === 'function'
      },
      null,
      { timeout: 5_000 }
    )

    const setSummarizeMode = async (mode: 'page' | 'video', slides: boolean) => {
      await page.evaluate(
        async (payload) => {
          const hooks = (
            window as typeof globalThis & {
              __summarizeTestHooks?: {
                setSummarizeMode?: (payload: {
                  mode: 'page' | 'video'
                  slides: boolean
                }) => Promise<void>
                getSummarizeMode?: () => {
                  mode: 'page' | 'video'
                  slides: boolean
                  mediaAvailable: boolean
                }
              }
            }
          ).__summarizeTestHooks
          await hooks?.setSummarizeMode?.(payload)
        },
        { mode, slides }
      )
    }

    const getSummarizeMode = async () =>
      await page.evaluate(() => {
        const hooks = (
          window as typeof globalThis & {
            __summarizeTestHooks?: {
              getSummarizeMode?: () => {
                mode: 'page' | 'video'
                slides: boolean
                mediaAvailable: boolean
              }
            }
          }
        ).__summarizeTestHooks
        return hooks?.getSummarizeMode?.() ?? null
      })

    const ensureMediaAvailable = async (slidesEnabled: boolean) => {
      const state = buildUiState({
        ...uiState,
        settings: { ...uiState.settings, slidesEnabled },
      })
      await expect
        .poll(async () => {
          await page.evaluate((payload) => {
            const hooks = (
              window as typeof globalThis & {
                __summarizeTestHooks?: { applyUiState?: (state: unknown) => void }
              }
            ).__summarizeTestHooks
            hooks?.applyUiState?.(payload)
          }, state)
          const mode = await getSummarizeMode()
          return mode?.mediaAvailable ?? false
        })
        .toBe(true)
    }

    await ensureMediaAvailable(false)
    await expect(summarizeButton).toHaveAttribute('aria-label', /Page(?: · 120 words)?/)

    await setSummarizeMode('page', false)
    await expect
      .poll(async () => await getSummarizeMode())
      .toEqual({ mode: 'page', slides: false, mediaAvailable: true })
    await expect(summarizeButton).toHaveAttribute('aria-label', /Page/)
    await sendBgMessage(harness, {
      type: 'run:start',
      run: {
        id: 'run-page',
        url: 'https://example.com/video',
        title: 'Example Video',
        model: 'auto',
        reason: 'manual',
      },
    })
    await waitForRunEvents('run-page')
    await expect(
      page.locator('img.slideStrip__thumbImage, img.slideInline__thumbImage')
    ).toHaveCount(0)

    await ensureMediaAvailable(false)
    await setSummarizeMode('video', false)
    await expect
      .poll(async () => await getSummarizeMode())
      .toEqual({ mode: 'video', slides: false, mediaAvailable: true })
    await expect(summarizeButton).toHaveAttribute('aria-label', /Video/)
    await sendBgMessage(harness, {
      type: 'run:start',
      run: {
        id: 'run-video',
        url: 'https://example.com/video',
        title: 'Example Video',
        model: 'auto',
        reason: 'manual',
      },
    })
    await waitForRunEvents('run-video')
    await expect(
      page.locator('img.slideStrip__thumbImage, img.slideInline__thumbImage')
    ).toHaveCount(0)

    await ensureMediaAvailable(true)
    await setSummarizeMode('video', true)
    await expect
      .poll(async () => await getSummarizeMode())
      .toEqual({ mode: 'video', slides: true, mediaAvailable: true })
    await sendBgMessage(harness, {
      type: 'run:start',
      run: {
        id: 'run-slides',
        url: 'https://example.com/video',
        title: 'Example Video',
        model: 'auto',
        reason: 'manual',
      },
    })
    await waitForRunEvents('run-slides')

    await page.waitForFunction(
      () => {
        const hooks = (
          window as typeof globalThis & {
            __summarizeTestHooks?: { applySlidesPayload?: (payload: unknown) => void }
          }
        ).__summarizeTestHooks
        return Boolean(hooks?.applySlidesPayload)
      },
      null,
      { timeout: 5_000 }
    )
    const slidesPayload = {
      sourceUrl: 'https://example.com/video',
      sourceId: 'example-video',
      sourceKind: 'url',
      ocrAvailable: true,
      slides: [
        {
          index: 1,
          timestamp: 0,
          imageUrl: 'http://127.0.0.1:8787/v1/slides/example-video/1?v=1',
          ocrText: 'Slide one shows the overview and key takeaways.',
        },
        {
          index: 2,
          timestamp: 10,
          imageUrl: 'http://127.0.0.1:8787/v1/slides/example-video/2?v=1',
          ocrText: 'Slide two breaks down the details with metrics.',
        },
      ],
    }
    await page.evaluate((payload) => {
      const hooks = (
        window as typeof globalThis & {
          __summarizeTestHooks?: { applySlidesPayload?: (payload: unknown) => void }
        }
      ).__summarizeTestHooks
      hooks?.applySlidesPayload?.(payload)
    }, slidesPayload)
    await expect.poll(async () => (await getPanelSlideDescriptions(page)).length).toBe(2)
    await expect.poll(async () => (await getSummarizeMode())?.slides ?? false).toBe(true)
    const getSlidesState = async () =>
      await page.evaluate(() => {
        const hooks = (
          window as typeof globalThis & {
            __summarizeTestHooks?: {
              getSlidesState?: () => { slidesCount: number; layout: string; hasSlides: boolean }
              renderSlidesNow?: () => void
              applyUiState?: (state: unknown) => void
            }
          }
        ).__summarizeTestHooks
        return hooks?.getSlidesState?.() ?? null
      })
    await expect.poll(async () => (await getSlidesState())?.slidesCount ?? 0).toBe(2)
    const renderedCount = await page.evaluate(() => {
      const hooks = (
        window as typeof globalThis & {
          __summarizeTestHooks?: { forceRenderSlides?: () => number }
        }
      ).__summarizeTestHooks
      return hooks?.forceRenderSlides?.() ?? 0
    })
    expect(renderedCount).toBeGreaterThan(0)

    const slideImages = page.locator('img.slideInline__thumbImage, img.slideStrip__thumbImage')
    await expect(slideImages).toHaveCount(2)
    await slideImages.first().scrollIntoViewIfNeeded()
    await expect
      .poll(
        async () => {
          const loaded = await slideImages.evaluateAll((nodes) =>
            nodes.map((node) => Boolean(node.dataset.slideImageUrl))
          )
          return loaded.every(Boolean)
        },
        { timeout: 10_000 }
      )
      .toBe(true)
    await expect(page.locator('.slideGallery__text, .slideStrip__text')).toContainText([
      'Slide one shows the overview',
      'Slide two breaks down the details',
    ])

    await ensureMediaAvailable(false)
    await setSummarizeMode('page', false)
    await expect
      .poll(async () => await getSummarizeMode())
      .toEqual({ mode: 'page', slides: false, mediaAvailable: true })
    await expect(summarizeButton).toHaveAttribute('aria-label', /Page/)
    await sendBgMessage(harness, {
      type: 'run:start',
      run: {
        id: 'run-back',
        url: 'https://example.com/video',
        title: 'Example Video',
        model: 'auto',
        reason: 'manual',
      },
    })
    await expect(
      page.locator('img.slideStrip__thumbImage, img.slideInline__thumbImage')
    ).toHaveCount(0)
    await expect(page.locator('.slideGallery__text, .slideStrip__text')).toHaveCount(0)

    assertNoErrors(harness)
  } finally {
    await closeExtension(harness.context, harness.userDataDir)
  }
})

test('sidepanel scrolls YouTube slides and shows text for each slide', async ({
  browserName: _browserName,
}, testInfo) => {
  const harness = await launchExtension(getBrowserFromProject(testInfo.project.name))

  try {
    await seedSettings(harness, {
      token: 'test-token',
      autoSummarize: false,
      slidesEnabled: true,
      slidesLayout: 'gallery',
      slidesOcrEnabled: true,
    })
    const page = await openExtensionPage(harness, 'sidepanel.html', '#title', () => {
      ;(
        window as typeof globalThis & { __summarizeTestHooks?: Record<string, unknown> }
      ).__summarizeTestHooks = {}
    })
    await waitForPanelPort(page)

    const placeholderPng = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO3kq0cAAAAASUVORK5CYII=',
      'base64'
    )
    await page.route('http://127.0.0.1:8787/v1/slides/**', async (route) => {
      await route.fulfill({
        status: 200,
        headers: {
          'content-type': 'image/png',
          'x-summarize-slide-ready': '1',
        },
        body: placeholderPng,
      })
    })

    const sourceUrl = 'https://www.youtube.com/watch?v=scrollTest123'
    const uiState = buildUiState({
      tab: { id: 1, url: sourceUrl, title: 'Scroll Test' },
      media: { hasVideo: true, hasAudio: true, hasCaptions: false },
      stats: { pageWords: 120, videoDurationSeconds: 600 },
      settings: {
        autoSummarize: false,
        slidesEnabled: true,
        slidesOcrEnabled: true,
        slidesLayout: 'gallery',
        tokenPresent: true,
      },
      status: '',
    })
    await sendBgMessage(harness, { type: 'ui:state', state: uiState })

    await page.waitForFunction(
      () => {
        const hooks = (
          window as typeof globalThis & {
            __summarizeTestHooks?: { applySlidesPayload?: (payload: unknown) => void }
          }
        ).__summarizeTestHooks
        return Boolean(hooks?.applySlidesPayload)
      },
      null,
      { timeout: 5_000 }
    )

    const slidesPayload = buildSlidesPayload({
      sourceUrl,
      sourceId: 'yt-scroll',
      count: 12,
      textPrefix: 'YouTube',
    })
    await page.evaluate((payload) => {
      const hooks = (
        window as typeof globalThis & {
          __summarizeTestHooks?: { applySlidesPayload?: (payload: unknown) => void }
        }
      ).__summarizeTestHooks
      hooks?.applySlidesPayload?.(payload)
    }, slidesPayload)

    await expect.poll(async () => (await getPanelSlideDescriptions(page)).length).toBe(12)
    const renderedCount = await page.evaluate(() => {
      const hooks = (
        window as typeof globalThis & {
          __summarizeTestHooks?: { forceRenderSlides?: () => number }
        }
      ).__summarizeTestHooks
      return hooks?.forceRenderSlides?.() ?? 0
    })
    expect(renderedCount).toBeGreaterThan(0)

    const slideItems = page.locator('.slideGallery__item')
    await expect(slideItems).toHaveCount(12)

    const galleryList = page.locator('.slideGallery__list')
    await expect(galleryList).toBeVisible()
    await galleryList.evaluate((node) => {
      node.scrollTop = node.scrollHeight
    })
    await expect(slideItems.nth(11)).toBeVisible()

    await expect
      .poll(async () =>
        page.evaluate(() =>
          Array.from(
            document.querySelectorAll<HTMLImageElement>('img.slideInline__thumbImage')
          ).every((img) => (img.dataset.slideImageUrl ?? '').trim().length > 0)
        )
      )
      .toBe(true)

    await expect
      .poll(async () =>
        page.evaluate(() =>
          Array.from(document.querySelectorAll<HTMLElement>('.slideGallery__text')).every(
            (el) => (el.textContent ?? '').trim().length > 0
          )
        )
      )
      .toBe(true)

    const slideDescriptions = await getPanelSlideDescriptions(page)
    expect(slideDescriptions).toHaveLength(12)
    expect(slideDescriptions.every(([, text]) => text.trim().length > 0)).toBe(true)

    assertNoErrors(harness)
  } finally {
    await closeExtension(harness.context, harness.userDataDir)
  }
})

test('sidepanel video selection forces transcript mode', async ({
  browserName: _browserName,
}, testInfo) => {
  const harness = await launchExtension(getBrowserFromProject(testInfo.project.name))

  try {
    await mockDaemonSummarize(harness)
    await seedSettings(harness, { token: 'test-token', autoSummarize: false })
    const contentPage = await harness.context.newPage()
    await contentPage.route('https://www.youtube.com/**', async (route) => {
      await route.fulfill({
        status: 200,
        headers: { 'content-type': 'text/html' },
        body: '<html><body><article>Video placeholder</article></body></html>',
      })
    })
    await contentPage.goto('https://www.youtube.com/watch?v=abc123', {
      waitUntil: 'domcontentloaded',
    })
    await maybeBringToFront(contentPage)
    await activateTabByUrl(harness, 'https://www.youtube.com/watch?v=abc123')
    await waitForActiveTabUrl(harness, 'https://www.youtube.com/watch?v=abc123')
    await injectContentScript(
      harness,
      'content-scripts/extract.js',
      'https://www.youtube.com/watch?v=abc123'
    )

    const page = await openExtensionPage(harness, 'sidepanel.html', '#title')
    await waitForPanelPort(page)
    const mediaState = buildUiState({
      tab: { id: 1, url: 'https://www.youtube.com/watch?v=abc123', title: 'Example' },
      media: { hasVideo: true, hasAudio: false, hasCaptions: false },
      stats: { pageWords: 120, videoDurationSeconds: 90 },
      settings: { slidesEnabled: true },
      status: '',
    })
    await expect
      .poll(async () => {
        await sendBgMessage(harness, { type: 'ui:state', state: mediaState })
        return await page.locator('.summarizeButton.isDropdown').count()
      })
      .toBe(1)

    const sseBody = [
      'event: chunk',
      'data: {"text":"Hello world"}',
      '',
      'event: done',
      'data: {}',
      '',
    ].join('\n')
    await page.route('http://127.0.0.1:8787/v1/summarize/**', async (route) => {
      await route.fulfill({
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
        body: sseBody,
      })
    })

    await maybeBringToFront(contentPage)
    await activateTabByUrl(harness, 'https://www.youtube.com/watch?v=abc123')
    await waitForActiveTabUrl(harness, 'https://www.youtube.com/watch?v=abc123')

    await sendPanelMessage(page, { type: 'panel:summarize', inputMode: 'video', refresh: false })
    await expect
      .poll(async () => {
        const bodies = (await getSummarizeBodies(harness)) as Array<Record<string, unknown>>
        return bodies.some((body) => body?.videoMode === 'transcript')
      })
      .toBe(true)

    const bodies = (await getSummarizeBodies(harness)) as Array<Record<string, unknown>>
    const body = bodies.find((item) => item?.videoMode === 'transcript') ?? null
    expect(body?.mode).toBe('url')
    expect(body?.videoMode).toBe('transcript')
    assertNoErrors(harness)
  } finally {
    await closeExtension(harness.context, harness.userDataDir)
  }
})

test('sidepanel video selection requests slides when enabled', async ({
  browserName: _browserName,
}, testInfo) => {
  const harness = await launchExtension(getBrowserFromProject(testInfo.project.name))

  try {
    await mockDaemonSummarize(harness)
    await seedSettings(harness, {
      token: 'test-token',
      autoSummarize: false,
      slidesEnabled: true,
      slidesOcrEnabled: true,
    })
    const contentPage = await harness.context.newPage()
    await contentPage.route('https://www.youtube.com/**', async (route) => {
      await route.fulfill({
        status: 200,
        headers: { 'content-type': 'text/html' },
        body: '<html><body><article>Video placeholder</article></body></html>',
      })
    })
    await contentPage.goto('https://www.youtube.com/watch?v=dQw4w9WgXcQ', {
      waitUntil: 'domcontentloaded',
    })
    await maybeBringToFront(contentPage)
    await activateTabByUrl(harness, 'https://www.youtube.com/watch?v=dQw4w9WgXcQ')
    await waitForActiveTabUrl(harness, 'https://www.youtube.com/watch?v=dQw4w9WgXcQ')
    await injectContentScript(
      harness,
      'content-scripts/extract.js',
      'https://www.youtube.com/watch?v=dQw4w9WgXcQ'
    )

    const page = await openExtensionPage(harness, 'sidepanel.html', '#title')
    await waitForPanelPort(page)
    const mediaState = buildUiState({
      tab: { id: 1, url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', title: 'Example' },
      media: { hasVideo: true, hasAudio: false, hasCaptions: false },
      stats: { pageWords: 120, videoDurationSeconds: 90 },
      settings: { slidesEnabled: true },
      status: '',
    })
    await expect
      .poll(async () => {
        await sendBgMessage(harness, { type: 'ui:state', state: mediaState })
        return await page.locator('.summarizeButton.isDropdown').count()
      })
      .toBe(1)

    const sseBody = [
      'event: chunk',
      'data: {"text":"Hello world"}',
      '',
      'event: done',
      'data: {}',
      '',
    ].join('\n')
    await page.route('http://127.0.0.1:8787/v1/summarize/**', async (route) => {
      await route.fulfill({
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
        body: sseBody,
      })
    })

    await maybeBringToFront(contentPage)
    await activateTabByUrl(harness, 'https://www.youtube.com/watch?v=dQw4w9WgXcQ')
    await waitForActiveTabUrl(harness, 'https://www.youtube.com/watch?v=dQw4w9WgXcQ')

    await sendPanelMessage(page, { type: 'panel:summarize', inputMode: 'video', refresh: false })
    await expect
      .poll(async () => {
        const bodies = (await getSummarizeBodies(harness)) as Array<Record<string, unknown>>
        return bodies.some((body) => body?.videoMode === 'transcript' && body?.slides === true)
      })
      .toBe(true)

    const bodies = (await getSummarizeBodies(harness)) as Array<Record<string, unknown>>
    const body =
      bodies.find((item) => item?.videoMode === 'transcript' && item?.slides === true) ?? null
    expect(body?.mode).toBe('url')
    expect(body?.videoMode).toBe('transcript')
    expect(body?.slides).toBe(true)
    expect(body?.slidesOcr).toBe(true)
    assertNoErrors(harness)
  } finally {
    await closeExtension(harness.context, harness.userDataDir)
  }
})

test('sidepanel video selection does not request slides when disabled', async ({
  browserName: _browserName,
}, testInfo) => {
  const harness = await launchExtension(getBrowserFromProject(testInfo.project.name))

  try {
    await mockDaemonSummarize(harness)
    await seedSettings(harness, { token: 'test-token', autoSummarize: false, slidesEnabled: false })
    const contentPage = await harness.context.newPage()
    await contentPage.goto('https://example.com', { waitUntil: 'domcontentloaded' })
    await contentPage.evaluate(() => {
      document.body.innerHTML = `<article><p>${'Hello '.repeat(40)}</p></article>`
    })
    await maybeBringToFront(contentPage)
    await activateTabByUrl(harness, 'https://example.com')
    await waitForActiveTabUrl(harness, 'https://example.com')
    await injectContentScript(harness, 'content-scripts/extract.js', 'https://example.com')
    await waitForExtractReady(harness, 'https://example.com')

    const page = await openExtensionPage(harness, 'sidepanel.html', '#title', () => {
      ;(window as typeof globalThis & { IntersectionObserver?: unknown }).IntersectionObserver =
        undefined
    })
    const mediaState = buildUiState({
      tab: { id: 1, url: 'https://example.com', title: 'Example' },
      media: { hasVideo: true, hasAudio: false, hasCaptions: false },
      stats: { pageWords: 120, videoDurationSeconds: 90 },
      settings: { slidesEnabled: true },
      status: '',
    })
    await expect
      .poll(async () => {
        await sendBgMessage(harness, { type: 'ui:state', state: mediaState })
        return await page.locator('.summarizeButton.isDropdown').count()
      })
      .toBe(1)

    const sseBody = [
      'event: chunk',
      'data: {"text":"Hello world"}',
      '',
      'event: done',
      'data: {}',
      '',
    ].join('\n')
    await page.route('http://127.0.0.1:8787/v1/summarize/**', async (route) => {
      await route.fulfill({
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
        body: sseBody,
      })
    })

    await maybeBringToFront(contentPage)
    await activateTabByUrl(harness, 'https://example.com')
    await waitForActiveTabUrl(harness, 'https://example.com')

    await sendPanelMessage(page, { type: 'panel:summarize', inputMode: 'video', refresh: false })
    await expect.poll(() => getSummarizeCalls(harness)).toBe(1)

    const body = (await getSummarizeLastBody(harness)) as Record<string, unknown> | null
    expect(body?.mode).toBe('url')
    expect(body?.videoMode).toBe('transcript')
    expect(body?.slides).toBeUndefined()
    expect(body?.slidesOcr).toBeUndefined()
    assertNoErrors(harness)
  } finally {
    await closeExtension(harness.context, harness.userDataDir)
  }
})

test('sidepanel loads slide images after they become ready', async ({
  browserName: _browserName,
}, testInfo) => {
  const harness = await launchExtension(getBrowserFromProject(testInfo.project.name))

  try {
    await mockDaemonSummarize(harness)
    await seedSettings(harness, { token: 'test-token', autoSummarize: false, slidesEnabled: true })
    const page = await openExtensionPage(harness, 'sidepanel.html', '#title', () => {
      ;(
        window as typeof globalThis & { __summarizeTestHooks?: Record<string, unknown> }
      ).__summarizeTestHooks = {}
    })
    const mediaState = buildUiState({
      tab: { id: 1, url: 'https://example.com', title: 'Example' },
      media: { hasVideo: true, hasAudio: false, hasCaptions: false },
      stats: { pageWords: 120, videoDurationSeconds: 90 },
      status: '',
    })
    await expect
      .poll(async () => {
        await sendBgMessage(harness, { type: 'ui:state', state: mediaState })
        return await page.locator('.summarizeButton.isDropdown').count()
      })
      .toBe(1)

    const slidesPayload = {
      sourceUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      sourceId: 'dQw4w9WgXcQ',
      sourceKind: 'youtube',
      ocrAvailable: false,
      slides: [
        {
          index: 1,
          timestamp: 0,
          imageUrl: 'http://127.0.0.1:8787/v1/slides/dQw4w9WgXcQ/1?v=1',
        },
      ],
    }
    await page.waitForFunction(
      () => {
        const hooks = (
          window as typeof globalThis & {
            __summarizeTestHooks?: { applySlidesPayload?: (payload: unknown) => void }
          }
        ).__summarizeTestHooks
        return Boolean(hooks?.applySlidesPayload)
      },
      { timeout: 10_000 }
    )

    const placeholderPng = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO3kq0cAAAAASUVORK5CYII=',
      'base64'
    )
    let imageCalls = 0
    await harness.context.route(
      'http://127.0.0.1:8787/v1/slides/dQw4w9WgXcQ/1**',
      async (route) => {
        imageCalls += 1
        if (imageCalls < 2) {
          await route.fulfill({
            status: 200,
            headers: {
              'content-type': 'image/png',
              'access-control-allow-origin': '*',
              'access-control-expose-headers': 'x-summarize-slide-ready',
              'x-summarize-slide-ready': '0',
            },
            body: placeholderPng,
          })
          return
        }
        await route.fulfill({
          status: 200,
          headers: {
            'content-type': 'image/png',
            'access-control-allow-origin': '*',
            'access-control-expose-headers': 'x-summarize-slide-ready',
            'x-summarize-slide-ready': '1',
          },
          body: placeholderPng,
        })
      }
    )

    await page.evaluate((payload) => {
      const hooks = (
        window as typeof globalThis & {
          __summarizeTestHooks?: {
            applySlidesPayload?: (payload: unknown) => void
            forceRenderSlides?: () => number
          }
        }
      ).__summarizeTestHooks
      hooks?.applySlidesPayload?.(payload)
      hooks?.forceRenderSlides?.()
    }, slidesPayload)

    const img = page.locator('img.slideStrip__thumbImage, img.slideInline__thumbImage')
    await expect(img).toHaveCount(1, { timeout: 10_000 })
    await expect.poll(() => imageCalls, { timeout: 10_000 }).toBeGreaterThan(0)
    await expect.poll(() => imageCalls, { timeout: 10_000 }).toBeGreaterThan(1)
    await expect
      .poll(
        async () => {
          return await img.evaluate((node) => node.src)
        },
        { timeout: 10_000 }
      )
      .toContain('blob:')
    assertNoErrors(harness)
  } finally {
    await closeExtension(harness.context, harness.userDataDir)
  }
})

test('sidepanel extracts slides from local video via daemon', async ({
  browserName: _browserName,
}, testInfo) => {
  test.setTimeout(180_000)

  if (testInfo.project.name === 'firefox') {
    test.skip(true, 'Slides E2E is only validated in Chromium.')
  }
  if (!hasFfmpeg()) {
    test.skip(true, 'ffmpeg is required for slide extraction.')
  }
  if (await isPortInUse(DAEMON_PORT)) {
    const token = readDaemonToken()
    if (!token) {
      test.skip(
        true,
        `Port ${DAEMON_PORT} is in use, but daemon token is missing. Set SUMMARIZE_DAEMON_TOKEN or ensure ~/.summarize/daemon.json exists.`
      )
    }
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'summarize-slides-e2e-'))
  const videoPath = path.join(tmpDir, 'sample.mp4')
  const vttPath = path.join(tmpDir, 'sample.vtt')
  const html = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>Slides Test</title>
  </head>
  <body>
    <h1>Slides Test</h1>
    <p>Local video with captions for transcript extraction.</p>
    <video controls width="640" height="360" preload="metadata">
      <source src="/sample.mp4" type="video/mp4" />
      <track kind="captions" src="/sample.vtt" srclang="en" label="English" default />
    </video>
  </body>
</html>`
  const vtt = [
    'WEBVTT',
    '',
    '00:00.000 --> 00:02.000',
    'Intro slide.',
    '',
    '00:02.000 --> 00:04.000',
    'Second slide.',
    '',
    '00:04.000 --> 00:06.000',
    'Third slide.',
    '',
  ].join('\n')

  createSampleVideo(videoPath)
  fs.writeFileSync(vttPath, vtt, 'utf8')

  const server = createHttpServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (url.pathname === '/' || url.pathname === '/index.html') {
      const body = Buffer.from(html, 'utf8')
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'content-length': body.length,
      })
      res.end(body)
      return
    }
    if (url.pathname === '/sample.vtt') {
      const body = Buffer.from(vtt, 'utf8')
      res.writeHead(200, {
        'content-type': 'text/vtt; charset=utf-8',
        'content-length': body.length,
      })
      res.end(body)
      return
    }
    if (url.pathname === '/sample.mp4') {
      const body = fs.readFileSync(videoPath)
      res.writeHead(200, {
        'content-type': 'video/mp4',
        'content-length': body.length,
      })
      res.end(body)
      return
    }
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('Not found')
  })

  let serverUrl = ''
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        reject(new Error('Failed to resolve local server port'))
        return
      }
      serverUrl = `http://127.0.0.1:${address.port}`
      resolve()
    })
  })

  const portBusy = await isPortInUse(DAEMON_PORT)
  const externalToken = portBusy ? readDaemonToken() : null
  const token = externalToken ?? DEFAULT_DAEMON_TOKEN
  const homeDir = portBusy ? null : fs.mkdtempSync(path.join(os.tmpdir(), 'summarize-daemon-e2e-'))
  const abortController = portBusy ? null : new AbortController()
  let daemonPromise: Promise<void> | null = null

  if (!portBusy) {
    let resolveReady: (() => void) | null = null
    const ready = new Promise<void>((resolve) => {
      resolveReady = resolve
    })
    const env = {
      ...process.env,
      HOME: homeDir ?? os.homedir(),
      USERPROFILE: homeDir ?? os.homedir(),
      TESSERACT_PATH: '/nonexistent',
    }
    for (const key of BLOCKED_ENV_KEYS) {
      delete env[key]
    }

    daemonPromise = runDaemonServer({
      env,
      fetchImpl: fetch,
      config: { token, port: DAEMON_PORT, version: 1, installedAt: new Date().toISOString() },
      port: DAEMON_PORT,
      signal: abortController?.signal,
      onListening: () => resolveReady?.(),
    })
    await ready
  }

  const harness = await launchExtension(getBrowserFromProject(testInfo.project.name))

  try {
    await seedSettings(harness, {
      token,
      autoSummarize: false,
      slidesEnabled: false,
      slidesParallel: false,
    })

    const contentPage = await harness.context.newPage()
    await contentPage.goto(`${serverUrl}/index.html`, { waitUntil: 'domcontentloaded' })
    await maybeBringToFront(contentPage)
    await activateTabByUrl(harness, serverUrl)
    await waitForActiveTabUrl(harness, serverUrl)
    await injectContentScript(harness, 'content-scripts/extract.js', serverUrl)
    const activeTabId = await getActiveTabId(harness)

    const page = await openExtensionPage(harness, 'sidepanel.html', '#title')
    await waitForPanelPort(page)

    await sendBgMessage(harness, {
      type: 'ui:state',
      state: buildUiState({
        tab: { id: activeTabId, url: `${serverUrl}/index.html`, title: 'Slides Test' },
        media: { hasVideo: true, hasAudio: false, hasCaptions: true },
        stats: { pageWords: 24, videoDurationSeconds: 6 },
        settings: { autoSummarize: false, slidesEnabled: false, slidesParallel: false },
        status: '',
      }),
    })

    await maybeBringToFront(contentPage)
    await activateTabByUrl(harness, serverUrl)
    await waitForActiveTabUrl(harness, serverUrl)

    const summarizeButton = page.locator('.summarizeButton')
    await expect(summarizeButton).toBeVisible()
    await summarizeButton.focus()
    await summarizeButton.press('ArrowDown')
    const pickerList = getOpenPickerList(page)
    await expect(pickerList.getByText('Video + Slides', { exact: true })).toBeVisible({
      timeout: 15_000,
    })
    await pickerList.getByText('Video + Slides', { exact: true }).click()
    await expect
      .poll(async () => {
        const settings = await getSettings(harness)
        return settings.slidesEnabled === true
      })
      .toBe(true)
    await expect(summarizeButton).toBeEnabled()
    await summarizeButton.click()

    const runId = await startDaemonSlidesRun(`${serverUrl}/index.html`, token)
    await waitForSlidesSnapshot(runId, token)
    await sendBgMessage(harness, {
      type: 'slides:run',
      ok: true,
      runId,
      url: `${serverUrl}/index.html`,
    })

    const img = page.locator('img.slideStrip__thumbImage, img.slideInline__thumbImage')
    await expect
      .poll(
        async () => {
          const count = await img.count()
          if (count === 0) return false
          const ready = await img.first().evaluate((node) => node.dataset.loaded === 'true')
          return ready
        },
        { timeout: 120_000 }
      )
      .toBe(true)

    assertNoErrors(harness)
  } finally {
    if (abortController && daemonPromise) {
      abortController.abort()
      await daemonPromise
    }
    await closeExtension(harness.context, harness.userDataDir)
    await new Promise<void>((resolve) => server.close(() => resolve()))
    fs.rmSync(tmpDir, { recursive: true, force: true })
    if (homeDir) fs.rmSync(homeDir, { recursive: true, force: true })
  }
})

test.describe('youtube e2e', () => {
  test('youtube regular summary matches cli output', async ({
    browserName: _browserName,
  }, testInfo) => {
    test.setTimeout(900_000)
    if (!allowYouTubeE2E) {
      test.skip(true, 'Set ALLOW_YOUTUBE_E2E=1 to run YouTube E2E tests.')
    }
    if (testInfo.project.name === 'firefox') {
      test.skip(true, 'YouTube E2E is only validated in Chromium.')
    }
    const token = readDaemonToken()
    if (!token) {
      test.skip(
        true,
        'Daemon token missing (set SUMMARIZE_DAEMON_TOKEN or ~/.summarize/daemon.json).'
      )
    }
    if (!(await isPortInUse(DAEMON_PORT))) {
      test.skip(true, `Daemon must be running on ${DAEMON_PORT}.`)
    }

    const harness = await launchExtension(getBrowserFromProject(testInfo.project.name))

    try {
      const length = 'short'
      await seedSettings(harness, {
        token,
        autoSummarize: false,
        slidesEnabled: false,
        slidesParallel: true,
        length,
      })

      const page = await openExtensionPage(harness, 'sidepanel.html', '#title', () => {
        ;(
          window as typeof globalThis & { __summarizeTestHooks?: Record<string, unknown> }
        ).__summarizeTestHooks = {}
      })
      await waitForPanelPort(page)

      const contentPage = await harness.context.newPage()

      for (const url of youtubeTestUrls) {
        const runId = await startDaemonSummaryRun({ url, token, length, slides: false })

        await contentPage.goto(url, { waitUntil: 'domcontentloaded' })
        await maybeBringToFront(contentPage)
        await activateTabByUrl(harness, 'https://www.youtube.com/watch')
        await waitForActiveTabUrl(harness, 'https://www.youtube.com/watch')
        const activeTabId = await getActiveTabId(harness)

        await sendBgMessage(harness, {
          type: 'ui:state',
          state: buildUiState({
            tab: { id: activeTabId, url, title: 'YouTube' },
            media: { hasVideo: true, hasAudio: false, hasCaptions: true },
            settings: { autoSummarize: false, slidesEnabled: false, slidesParallel: true, length },
          }),
        })

        await sendBgMessage(harness, {
          type: 'run:start',
          run: { id: runId, url, title: 'YouTube', model: 'auto', reason: 'test' },
        })

        await expect.poll(async () => await getPanelPhase(page), { timeout: 420_000 }).toBe('idle')

        const model = (await getPanelModel(page))?.trim() || 'auto'

        const cliSummary = runCliSummary(url, [
          '--json',
          '--length',
          length,
          '--language',
          'auto',
          '--model',
          model,
          '--video-mode',
          'transcript',
          '--timestamps',
        ])
        const panelSummary = await getPanelSummaryMarkdown(page)
        const normalizedPanel = normalizeWhitespace(panelSummary)
        const normalizedCli = normalizeWhitespace(cliSummary)
        expect(normalizedPanel.length).toBeGreaterThan(0)
        expect(normalizedCli.length).toBeGreaterThan(0)
        expect(overlapRatio(normalizedPanel, normalizedCli)).toBeGreaterThan(0.2)
      }

      assertNoErrors(harness)
    } finally {
      await closeExtension(harness.context, harness.userDataDir)
    }
  })

  test('youtube slides summary matches cli output', async ({
    browserName: _browserName,
  }, testInfo) => {
    test.setTimeout(1_200_000)
    if (!allowYouTubeE2E) {
      test.skip(true, 'Set ALLOW_YOUTUBE_E2E=1 to run YouTube E2E tests.')
    }
    if (testInfo.project.name === 'firefox') {
      test.skip(true, 'YouTube E2E is only validated in Chromium.')
    }
    if (!hasFfmpeg() || !hasYtDlp()) {
      test.skip(true, 'yt-dlp + ffmpeg are required for YouTube slide extraction.')
    }
    const token = readDaemonToken()
    if (!token) {
      test.skip(
        true,
        'Daemon token missing (set SUMMARIZE_DAEMON_TOKEN or ~/.summarize/daemon.json).'
      )
    }
    if (!(await isPortInUse(DAEMON_PORT))) {
      test.skip(true, `Daemon must be running on ${DAEMON_PORT}.`)
    }

    const harness = await launchExtension(getBrowserFromProject(testInfo.project.name))

    try {
      const length = 'short'
      await seedSettings(harness, {
        token,
        autoSummarize: false,
        slidesEnabled: true,
        slidesParallel: true,
        length,
      })

      const page = await openExtensionPage(harness, 'sidepanel.html', '#title', () => {
        ;(
          window as typeof globalThis & { __summarizeTestHooks?: Record<string, unknown> }
        ).__summarizeTestHooks = {}
      })
      await waitForPanelPort(page)

      const contentPage = await harness.context.newPage()

      for (const url of youtubeSlidesTestUrls) {
        const summaryRunId = await startDaemonSummaryRun({ url, token, length, slides: false })
        const slidesRunId = await startDaemonSummaryRun({
          url,
          token,
          length,
          slides: true,
          slidesMax: SLIDES_MAX,
        })

        await contentPage.goto(url, { waitUntil: 'domcontentloaded' })
        await maybeBringToFront(contentPage)
        await activateTabByUrl(harness, 'https://www.youtube.com/watch')
        await waitForActiveTabUrl(harness, 'https://www.youtube.com/watch')
        const activeTabId = await getActiveTabId(harness)

        await sendBgMessage(harness, {
          type: 'ui:state',
          state: buildUiState({
            tab: { id: activeTabId, url, title: 'YouTube' },
            media: { hasVideo: true, hasAudio: false, hasCaptions: true },
            settings: { autoSummarize: false, slidesEnabled: true, slidesParallel: true, length },
          }),
        })

        await sendBgMessage(harness, {
          type: 'run:start',
          run: { id: summaryRunId, url, title: 'YouTube', model: 'auto', reason: 'test' },
        })
        await sendBgMessage(harness, {
          type: 'slides:run',
          ok: true,
          runId: slidesRunId,
          url,
        })

        await expect.poll(async () => await getPanelPhase(page), { timeout: 420_000 }).toBe('idle')

        await expect
          .poll(async () => (await getPanelModel(page)) ?? '', { timeout: 120_000 })
          .not.toBe('')
        const model = (await getPanelModel(page)) ?? 'auto'

        await expect
          .poll(async () => (await getPanelSlidesTimeline(page)).length, { timeout: 600_000 })
          .toBeGreaterThan(0)
        const slidesTimeline = await getPanelSlidesTimeline(page)
        const transcriptTimedText = await getPanelTranscriptTimedText(page)
        const slidesModel = (await getPanelSlidesSummaryModel(page))?.trim() || model
        const cliSummary = runCliSummary(url, [
          '--slides',
          '--slides-ocr',
          '--slides-max',
          String(SLIDES_MAX),
          '--json',
          '--length',
          length,
          '--language',
          'auto',
          '--model',
          slidesModel,
          '--video-mode',
          'transcript',
          '--timestamps',
        ])
        const lengthArg = resolveSlidesLengthArg(length)
        const coercedSummary = coerceSummaryWithSlides({
          markdown: cliSummary,
          slides: slidesTimeline,
          transcriptTimedText: transcriptTimedText ?? null,
          lengthArg,
        })
        if (process.env.SUMMARIZE_DEBUG_SLIDES === '1') {
          const panelSummary = await getPanelSummaryMarkdown(page)
          const slidesSummary = await getPanelSlidesSummaryMarkdown(page)
          const slidesSummaryComplete = await getPanelSlidesSummaryComplete(page)
          const slidesSummaryModel = await getPanelSlidesSummaryModel(page)
          fs.writeFileSync('/tmp/summarize-slides-cli.md', cliSummary)
          fs.writeFileSync('/tmp/summarize-slides-panel.md', slidesSummary)
          console.log('[slides-debug]', {
            url,
            panelSummaryLength: panelSummary.length,
            slidesSummaryLength: slidesSummary.length,
            slidesSummaryComplete,
            slidesSummaryModel,
          })
        }
        const expectedSlides = parseSlidesFromSummary(coercedSummary)
        expect(expectedSlides.length).toBeGreaterThan(0)

        await expect
          .poll(async () => (await getPanelSlideDescriptions(page)).length, { timeout: 600_000 })
          .toBeGreaterThan(0)
        const panelSlides = (await getPanelSlideDescriptions(page))
          .map(([index, text]) => ({ index, text: normalizeWhitespace(text) }))
          .sort((a, b) => a.index - b.index)

        for (const slide of panelSlides) {
          expect(slide.text.length).toBeGreaterThan(0)
        }

        const panelIndexes = panelSlides.map((entry) => entry.index)
        const expectedIndexes = expectedSlides.map((entry) => entry.index)
        expect(panelIndexes).toEqual(expectedIndexes)

        for (let i = 0; i < expectedSlides.length; i += 1) {
          const expected = expectedSlides[i]
          const actual = panelSlides[i]
          if (!expected || !actual) continue
          if (!expected.text) continue
          expect(actual.text.length).toBeGreaterThan(0)
          expect(overlapRatio(actual.text, expected.text)).toBeGreaterThanOrEqual(0.15)
        }
      }

      assertNoErrors(harness)
    } finally {
      await closeExtension(harness.context, harness.userDataDir)
    }
  })
})

test('sidepanel shows an error when agent request fails', async ({
  browserName: _browserName,
}, testInfo) => {
  const harness = await launchExtension(getBrowserFromProject(testInfo.project.name))

  try {
    await seedSettings(harness, { token: 'test-token', autoSummarize: false, chatEnabled: true })
    const contentPage = await harness.context.newPage()
    await contentPage.goto('https://example.com', { waitUntil: 'domcontentloaded' })
    await contentPage.evaluate(() => {
      document.body.innerHTML = `<article><p>${'Agent error test. '.repeat(12)}</p></article>`
    })
    await maybeBringToFront(contentPage)
    await activateTabByUrl(harness, 'https://example.com')
    await waitForActiveTabUrl(harness, 'https://example.com')
    await injectContentScript(harness, 'content-scripts/extract.js', 'https://example.com')
    await waitForExtractReady(harness, 'https://example.com')

    let agentCalls = 0
    await harness.context.route('http://127.0.0.1:8787/v1/agent', async (route) => {
      agentCalls += 1
      await route.fulfill({
        status: 500,
        headers: { 'content-type': 'text/plain' },
        body: 'Boom',
      })
    })

    const page = await openExtensionPage(harness, 'sidepanel.html', '#title')
    await waitForPanelPort(page)
    await maybeBringToFront(contentPage)
    await activateTabByUrl(harness, 'https://example.com')
    await waitForActiveTabUrl(harness, 'https://example.com')
    await sendBgMessage(harness, {
      type: 'ui:state',
      state: buildUiState({
        tab: { id: 1, url: 'https://example.com', title: 'Example' },
        settings: { chatEnabled: true, tokenPresent: true },
      }),
    })

    await expect(page.locator('#chatSend')).toBeEnabled()
    await page.locator('#chatInput').fill('Trigger agent error')
    await page.locator('#chatSend').click()

    await expect.poll(() => agentCalls).toBe(1)
    await expect(page.locator('#inlineError')).toBeVisible()
    await expect(page.locator('#inlineErrorMessage')).toContainText('Chat request failed: Boom')
    await expect(page.locator('.chatMessage.assistant.streaming')).toHaveCount(0)
    assertNoErrors(harness)
  } finally {
    await closeExtension(harness.context, harness.userDataDir)
  }
})

test('sidepanel hides inline error when message is empty', async ({
  browserName: _browserName,
}, testInfo) => {
  const harness = await launchExtension(getBrowserFromProject(testInfo.project.name))

  try {
    const page = await openExtensionPage(harness, 'sidepanel.html', '#title', () => {
      ;(
        window as typeof globalThis & { __summarizeTestHooks?: Record<string, unknown> }
      ).__summarizeTestHooks = {}
    })
    await waitForPanelPort(page)

    await page.evaluate(() => {
      const hooks = (
        window as typeof globalThis & {
          __summarizeTestHooks?: {
            showInlineError?: (message: string) => void
            isInlineErrorVisible?: () => boolean
            getInlineErrorMessage?: () => string
          }
        }
      ).__summarizeTestHooks
      hooks?.showInlineError?.('Boom')
    })
    await expect(page.locator('#inlineError')).toBeVisible()

    await page.evaluate(() => {
      const hooks = (
        window as typeof globalThis & {
          __summarizeTestHooks?: {
            showInlineError?: (message: string) => void
            isInlineErrorVisible?: () => boolean
            getInlineErrorMessage?: () => string
          }
        }
      ).__summarizeTestHooks
      hooks?.showInlineError?.('   ')
    })

    await expect(page.locator('#inlineError')).toBeHidden()
    await expect(page.locator('#inlineErrorMessage')).toHaveText('')
    assertNoErrors(harness)
  } finally {
    await closeExtension(harness.context, harness.userDataDir)
  }
})

test('sidepanel shows daemon upgrade hint when /v1/agent is missing', async ({
  browserName: _browserName,
}, testInfo) => {
  const harness = await launchExtension(getBrowserFromProject(testInfo.project.name))

  try {
    await seedSettings(harness, { token: 'test-token', autoSummarize: false, chatEnabled: true })
    const contentPage = await harness.context.newPage()
    await contentPage.goto('https://example.com', { waitUntil: 'domcontentloaded' })
    await contentPage.evaluate(() => {
      document.body.innerHTML = `<article><p>${'Agent 404 test. '.repeat(12)}</p></article>`
    })
    await maybeBringToFront(contentPage)
    await activateTabByUrl(harness, 'https://example.com')
    await waitForActiveTabUrl(harness, 'https://example.com')
    await injectContentScript(harness, 'content-scripts/extract.js', 'https://example.com')
    await waitForExtractReady(harness, 'https://example.com')

    let agentCalls = 0
    await harness.context.route('http://127.0.0.1:8787/v1/agent', async (route) => {
      agentCalls += 1
      await route.fulfill({
        status: 404,
        headers: { 'content-type': 'text/plain' },
        body: 'Not Found',
      })
    })

    const page = await openExtensionPage(harness, 'sidepanel.html', '#title')
    await waitForPanelPort(page)
    await maybeBringToFront(contentPage)
    await activateTabByUrl(harness, 'https://example.com')
    await waitForActiveTabUrl(harness, 'https://example.com')
    await sendBgMessage(harness, {
      type: 'ui:state',
      state: buildUiState({
        tab: { id: 1, url: 'https://example.com', title: 'Example' },
        settings: { chatEnabled: true, tokenPresent: true },
      }),
    })

    await expect(page.locator('#chatSend')).toBeEnabled()
    await page.locator('#chatInput').fill('Trigger agent 404')
    await page.locator('#chatSend').click()

    await expect.poll(() => agentCalls).toBe(1)
    await expect(page.locator('#inlineError')).toBeVisible()
    await expect(page.locator('#inlineErrorMessage')).toContainText(
      'Daemon does not support /v1/agent'
    )
    assertNoErrors(harness)
  } finally {
    await closeExtension(harness.context, harness.userDataDir)
  }
})

test('sidepanel shows automation notice when permission event fires', async ({
  browserName: _browserName,
}, testInfo) => {
  const harness = await launchExtension(getBrowserFromProject(testInfo.project.name))

  try {
    const page = await openExtensionPage(harness, 'sidepanel.html', '#title')
    await waitForPanelPort(page)
    await page.evaluate(() => {
      window.dispatchEvent(
        new CustomEvent('summarize:automation-permissions', {
          detail: {
            title: 'User Scripts required',
            message: 'Enable User Scripts to use automation.',
            ctaLabel: 'Open extension details',
          },
        })
      )
    })

    await expect(page.locator('#automationNotice')).toBeVisible()
    await expect(page.locator('#automationNoticeMessage')).toContainText('Enable User Scripts')
    assertNoErrors(harness)
  } finally {
    await closeExtension(harness.context, harness.userDataDir)
  }
})

test('sidepanel chat queue sends next message after stream completes', async ({
  browserName: _browserName,
}, testInfo) => {
  const harness = await launchExtension(getBrowserFromProject(testInfo.project.name))

  try {
    await seedSettings(harness, { token: 'test-token', autoSummarize: false, chatEnabled: true })
    const contentPage = await harness.context.newPage()
    await contentPage.goto('https://example.com', { waitUntil: 'domcontentloaded' })
    await contentPage.evaluate(() => {
      document.body.innerHTML = `<article><p>${'Hello '.repeat(40)}</p><p>More text for chat.</p></article>`
    })
    await maybeBringToFront(contentPage)
    await activateTabByUrl(harness, 'https://example.com')
    await waitForActiveTabUrl(harness, 'https://example.com')
    await injectContentScript(harness, 'content-scripts/extract.js', 'https://example.com')
    await waitForExtractReady(harness, 'https://example.com')

    const page = await openExtensionPage(harness, 'sidepanel.html', '#title')

    let agentRequestCount = 0
    let releaseFirst: (() => void) | null = null
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })

    await harness.context.route('http://127.0.0.1:8787/v1/agent', async (route) => {
      agentRequestCount += 1
      if (agentRequestCount === 1) await firstGate
      const body = buildAgentStream(`Reply ${agentRequestCount}`)
      await route.fulfill({
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
        body,
      })
    })

    const sendChat = async (text: string) => {
      await page.evaluate((value) => {
        const input = document.getElementById('chatInput') as HTMLTextAreaElement | null
        const send = document.getElementById('chatSend') as HTMLButtonElement | null
        if (!input || !send) return
        input.value = value
        input.dispatchEvent(new Event('input', { bubbles: true }))
        send.click()
      }, text)
    }

    await maybeBringToFront(contentPage)
    await activateTabByUrl(harness, 'https://example.com')
    await waitForActiveTabUrl(harness, 'https://example.com')
    await sendChat('First question')
    await expect.poll(() => agentRequestCount).toBe(1)
    await sendChat('Second question')
    await expect.poll(() => agentRequestCount, { timeout: 1_000 }).toBe(1)

    releaseFirst?.()

    await expect.poll(() => agentRequestCount).toBe(2)
    await expect(page.locator('#chatMessages')).toContainText('Second question')

    assertNoErrors(harness)
  } finally {
    await closeExtension(harness.context, harness.userDataDir)
  }
})

test('sidepanel chat queue drains messages after stream completes', async ({
  browserName: _browserName,
}, testInfo) => {
  const harness = await launchExtension(getBrowserFromProject(testInfo.project.name))

  try {
    await seedSettings(harness, { token: 'test-token', autoSummarize: false, chatEnabled: true })
    const contentPage = await harness.context.newPage()
    await contentPage.goto('https://example.com', { waitUntil: 'domcontentloaded' })
    await contentPage.evaluate(() => {
      document.body.innerHTML = `<article><p>${'Hello '.repeat(40)}</p><p>More text for chat.</p></article>`
    })
    await maybeBringToFront(contentPage)
    await activateTabByUrl(harness, 'https://example.com')
    await waitForActiveTabUrl(harness, 'https://example.com')
    await injectContentScript(harness, 'content-scripts/extract.js', 'https://example.com')
    await waitForExtractReady(harness, 'https://example.com')

    const page = await openExtensionPage(harness, 'sidepanel.html', '#title')

    let agentRequestCount = 0
    let releaseFirst: (() => void) | null = null
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })

    await harness.context.route('http://127.0.0.1:8787/v1/agent', async (route) => {
      agentRequestCount += 1
      if (agentRequestCount === 1) await firstGate
      const body = buildAgentStream(`Reply ${agentRequestCount}`)
      await route.fulfill({
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
        body,
      })
    })

    const sendChat = async (text: string) => {
      await page.evaluate((value) => {
        const input = document.getElementById('chatInput') as HTMLTextAreaElement | null
        const send = document.getElementById('chatSend') as HTMLButtonElement | null
        if (!input || !send) return
        input.value = value
        input.dispatchEvent(new Event('input', { bubbles: true }))
        send.click()
      }, text)
    }

    await maybeBringToFront(contentPage)
    await activateTabByUrl(harness, 'https://example.com')
    await waitForActiveTabUrl(harness, 'https://example.com')
    await sendChat('First question')
    await expect.poll(() => agentRequestCount).toBe(1)

    const enqueueChat = async (text: string) => {
      await page.evaluate((value) => {
        const input = document.getElementById('chatInput') as HTMLTextAreaElement | null
        if (!input) return
        input.value = value
        input.dispatchEvent(new Event('input', { bubbles: true }))
        input.dispatchEvent(
          new KeyboardEvent('keydown', {
            key: 'Enter',
            code: 'Enter',
            bubbles: true,
            cancelable: true,
          })
        )
      }, text)
    }

    await enqueueChat('Second question')
    await enqueueChat('Third question')

    releaseFirst?.()

    await expect.poll(() => agentRequestCount).toBeGreaterThanOrEqual(3)
    await expect(page.locator('#chatMessages')).toContainText('Second question')
    await expect(page.locator('#chatMessages')).toContainText('Third question')

    assertNoErrors(harness)
  } finally {
    await closeExtension(harness.context, harness.userDataDir)
  }
})

test('sidepanel clears chat on user navigation', async ({
  browserName: _browserName,
}, testInfo) => {
  const harness = await launchExtension(getBrowserFromProject(testInfo.project.name))

  try {
    await seedSettings(harness, { token: 'test-token', autoSummarize: false, chatEnabled: true })
    const contentPage = await harness.context.newPage()
    await contentPage.goto('https://example.com', { waitUntil: 'domcontentloaded' })
    await contentPage.evaluate(() => {
      document.body.innerHTML = `<article><p>Chat nav test.</p></article>`
    })
    await maybeBringToFront(contentPage)
    await activateTabByUrl(harness, 'https://example.com')
    await waitForActiveTabUrl(harness, 'https://example.com')
    await injectContentScript(harness, 'content-scripts/extract.js', 'https://example.com')

    await harness.context.route('http://127.0.0.1:8787/v1/agent', async (route) => {
      const body = buildAgentStream('Ack')
      await route.fulfill({
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
        body,
      })
    })

    const page = await openExtensionPage(harness, 'sidepanel.html', '#title')
    await sendBgMessage(harness, {
      type: 'ui:state',
      state: buildUiState({
        tab: { id: 1, url: 'https://example.com', title: 'Example' },
        settings: { chatEnabled: true, tokenPresent: true },
      }),
    })

    await page.evaluate((value) => {
      const input = document.getElementById('chatInput') as HTMLTextAreaElement | null
      const send = document.getElementById('chatSend') as HTMLButtonElement | null
      if (!input || !send) return
      input.value = value
      input.dispatchEvent(new Event('input', { bubbles: true }))
      send.click()
    }, 'Hello')

    await expect(page.locator('#chatMessages')).toContainText('Hello')

    await sendBgMessage(harness, {
      type: 'ui:state',
      state: buildUiState({
        tab: { id: 1, url: 'https://example.com/next', title: 'Next' },
        settings: { chatEnabled: true, tokenPresent: true },
      }),
    })

    await expect(page.locator('.chatMessage')).toHaveCount(0)
    assertNoErrors(harness)
  } finally {
    await closeExtension(harness.context, harness.userDataDir)
  }
})

test('auto summarize reruns after panel reopen', async ({
  browserName: _browserName,
}, testInfo) => {
  const harness = await launchExtension(getBrowserFromProject(testInfo.project.name))

  try {
    await mockDaemonSummarize(harness)

    const sseBody = [
      'event: chunk',
      'data: {"text":"First chunk"}',
      '',
      'event: done',
      'data: {}',
      '',
    ].join('\n')
    await harness.context.route(
      /http:\/\/127\.0\.0\.1:8787\/v1\/summarize\/[^/]+\/events/,
      async (route) => {
        await route.fulfill({
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
          body: sseBody,
        })
      }
    )

    await seedSettings(harness, { token: 'test-token', autoSummarize: true })

    const contentPage = await harness.context.newPage()
    await contentPage.goto('https://example.com', { waitUntil: 'domcontentloaded' })
    const activeUrl = contentPage.url()
    await maybeBringToFront(contentPage)
    await activateTabByUrl(harness, 'https://example.com')
    await waitForActiveTabUrl(harness, 'https://example.com')

    const panel = await openExtensionPage(harness, 'sidepanel.html', '#title')
    await maybeBringToFront(contentPage)
    await activateTabByUrl(harness, 'https://example.com')
    await waitForActiveTabUrl(harness, 'https://example.com')
    await mockDaemonSummarize(harness)
    await sendPanelMessage(panel, { type: 'panel:ready' })
    await expect.poll(async () => await getSummarizeCalls(harness)).toBeGreaterThanOrEqual(1)
    await sendPanelMessage(panel, { type: 'panel:rememberUrl', url: activeUrl })

    const callsBeforeClose = await getSummarizeCalls(harness)
    await sendPanelMessage(panel, { type: 'panel:closed' })
    await maybeBringToFront(contentPage)
    await activateTabByUrl(harness, 'https://example.com')
    await waitForActiveTabUrl(harness, 'https://example.com')
    await mockDaemonSummarize(harness)
    await sendPanelMessage(panel, { type: 'panel:ready' })
    await expect
      .poll(async () => await getSummarizeCalls(harness))
      .toBeGreaterThan(callsBeforeClose)
    assertNoErrors(harness)
  } finally {
    await closeExtension(harness.context, harness.userDataDir)
  }
})

test('sidepanel updates title while streaming on same URL', async ({
  browserName: _browserName,
}, testInfo) => {
  const harness = await launchExtension(getBrowserFromProject(testInfo.project.name))

  try {
    await mockDaemonSummarize(harness)
    let releaseSse: (() => void) | null = null
    const sseGate = new Promise<void>((resolve) => {
      releaseSse = resolve
    })
    const sseBody = [
      'event: chunk',
      'data: {"text":"Hello"}',
      '',
      'event: done',
      'data: {}',
      '',
    ].join('\n')
    await harness.context.route(
      /http:\/\/127\.0\.0\.1:8787\/v1\/summarize\/[^/]+\/events/,
      async (route) => {
        await sseGate
        await route.fulfill({
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
          body: sseBody,
        })
      }
    )

    await seedSettings(harness, { token: 'test-token', autoSummarize: false })
    const page = await openExtensionPage(harness, 'sidepanel.html', '#title')

    await sendBgMessage(harness, {
      type: 'run:start',
      run: {
        id: 'run-1',
        url: 'https://example.com/watch?v=1',
        title: 'Old Title',
        model: 'auto',
        reason: 'manual',
      },
    })
    await expect(page.locator('#title')).toHaveText('Old Title')

    await sendBgMessage(harness, {
      type: 'ui:state',
      state: buildUiState({
        tab: { url: 'https://example.com/watch?v=1', title: 'New Title' },
        settings: { autoSummarize: false, tokenPresent: true },
        status: '',
      }),
    })
    await expect(page.locator('#title')).toHaveText('New Title')

    releaseSse?.()
    await new Promise((resolve) => setTimeout(resolve, 200))
    assertNoErrors(harness)
  } finally {
    await closeExtension(harness.context, harness.userDataDir)
  }
})

test('hover tooltip proxies daemon calls via background (no page-origin localhost fetch)', async ({
  browserName: _browserName,
}, testInfo) => {
  test.setTimeout(30_000)
  const harness = await launchExtension(getBrowserFromProject(testInfo.project.name))

  try {
    await seedSettings(harness, { token: 'test-token', hoverSummaries: true })
    await mockDaemonSummarize(harness)

    let eventsCalls = 0

    const sseBody = [
      'event: chunk',
      'data: {"text":"Hello hover"}',
      '',
      'event: done',
      'data: {}',
      '',
    ].join('\n')
    await harness.context.route(
      /http:\/\/127\.0\.0\.1:8787\/v1\/summarize\/[^/]+\/events/,
      async (route) => {
        eventsCalls += 1
        await route.fulfill({
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
          body: sseBody,
        })
      }
    )

    const page = await harness.context.newPage()
    trackErrors(page, harness.pageErrors, harness.consoleErrors)
    await page.goto('https://example.com', { waitUntil: 'domcontentloaded' })
    await maybeBringToFront(page)
    await activateTabByUrl(harness, 'https://example.com')
    await waitForActiveTabUrl(harness, 'https://example.com')

    const background = await getBackground(harness)
    const hoverResponse = await background.evaluate(async () => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
      if (!tab?.id) return { ok: false, error: 'missing tab' }
      const [result] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        world: 'ISOLATED',
        func: async () => {
          return chrome.runtime.sendMessage({
            type: 'hover:summarize',
            requestId: 'hover-1',
            url: 'https://example.com/next',
            title: 'Next',
            token: 'test-token',
          })
        },
      })
      return result?.result ?? { ok: false, error: 'no response' }
    })
    expect(hoverResponse).toEqual(expect.objectContaining({ ok: true }))

    await expect.poll(() => getSummarizeCalls(harness)).toBeGreaterThan(0)
    await expect.poll(() => eventsCalls).toBeGreaterThan(0)

    assertNoErrors(harness)
  } finally {
    await closeExtension(harness.context, harness.userDataDir)
  }
})

test('content script extracts visible duration metadata', async ({
  browserName: _browserName,
}, testInfo) => {
  test.setTimeout(45_000)
  const harness = await launchExtension(getBrowserFromProject(testInfo.project.name))

  try {
    await seedSettings(harness, { token: 'test-token', autoSummarize: false })
    const contentPage = await harness.context.newPage()
    trackErrors(contentPage, harness.pageErrors, harness.consoleErrors)
    await contentPage.goto('https://example.com', { waitUntil: 'domcontentloaded' })
    await contentPage.evaluate(() => {
      document.title = 'Test Video'
      const meta = document.createElement('meta')
      meta.setAttribute('itemprop', 'duration')
      meta.setAttribute('content', 'PT36M10S')
      document.head.append(meta)
      const duration = document.createElement('div')
      duration.className = 'ytp-time-duration'
      duration.textContent = '36:10'
      document.body.innerHTML = '<article><p>Sample transcript text.</p></article>'
      document.body.append(duration)
    })

    await activateTabByUrl(harness, 'https://example.com')
    await waitForActiveTabUrl(harness, 'https://example.com')
    await injectContentScript(harness, 'content-scripts/extract.js', 'https://example.com')

    const background = await getBackground(harness)
    const extractResult = await background.evaluate(async () => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
      if (!tab?.id) return { ok: false, error: 'missing tab' }
      return new Promise((resolve) => {
        chrome.tabs.sendMessage(tab.id, { type: 'extract', maxChars: 10_000 }, (response) => {
          resolve(response ?? { ok: false, error: 'no response' })
        })
      })
    })
    expect(extractResult).toEqual(
      expect.objectContaining({
        ok: true,
        mediaDurationSeconds: 2170,
      })
    )
    assertNoErrors(harness)
  } finally {
    await closeExtension(harness.context, harness.userDataDir)
  }
})

test('options pickers support keyboard selection', async ({
  browserName: _browserName,
}, testInfo) => {
  const harness = await launchExtension(getBrowserFromProject(testInfo.project.name))

  try {
    const page = await openExtensionPage(harness, 'options.html', '#tabs')
    await page.click('#tab-ui')
    await expect(page.locator('#panel-ui')).toBeVisible()

    const schemeLabel = page.locator('label.scheme')
    const schemeTrigger = schemeLabel.locator('.pickerTrigger')

    await schemeTrigger.focus()
    await schemeTrigger.press('Enter')
    const schemeList = getOpenPickerList(page)
    await expect(schemeList).toBeVisible()
    await schemeList.focus()
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('Enter')

    await expect(schemeTrigger.locator('.scheme-label')).toHaveText('Mint')

    const modeLabel = page.locator('label.mode')
    const modeTrigger = modeLabel.locator('.pickerTrigger')

    await modeTrigger.focus()
    await modeTrigger.press('Enter')
    const modeList = getOpenPickerList(page)
    await expect(modeList).toBeVisible()
    await modeList.focus()
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('Enter')

    await expect(modeTrigger).toHaveText('Light')
    assertNoErrors(harness)
  } finally {
    await closeExtension(harness.context, harness.userDataDir)
  }
})

test('options keeps custom model selected while presets refresh', async ({
  browserName: _browserName,
}, testInfo) => {
  const harness = await launchExtension(getBrowserFromProject(testInfo.project.name))

  try {
    await seedSettings(harness, { token: 'test-token', model: 'auto' })
    let modelCalls = 0
    let releaseSecond: (() => void) | null = null
    const secondGate = new Promise<void>((resolve) => {
      releaseSecond = resolve
    })

    await harness.context.route('http://127.0.0.1:8787/v1/models', async (route) => {
      modelCalls += 1
      if (modelCalls === 2) await secondGate
      await route.fulfill({
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          ok: true,
          options: [{ id: 'auto', label: '' }],
          providers: { openrouter: true },
        }),
      })
    })
    await harness.context.route('http://127.0.0.1:8787/health', async (route) => {
      await route.fulfill({
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ok: true, version: '0.0.0' }),
      })
    })
    await harness.context.route('http://127.0.0.1:8787/v1/ping', async (route) => {
      await route.fulfill({
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ok: true }),
      })
    })

    const page = await openExtensionPage(harness, 'options.html', '#tabs')
    await page.click('#tab-model')
    await expect(page.locator('#panel-model')).toBeVisible()
    await expect.poll(() => modelCalls).toBeGreaterThanOrEqual(1)
    await expect(page.locator('#modelPreset')).toHaveValue('auto')

    await page.evaluate(() => {
      const preset = document.getElementById('modelPreset') as HTMLSelectElement | null
      if (!preset) return
      preset.value = 'custom'
      preset.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await expect(page.locator('#modelCustom')).toBeVisible()

    await page.locator('#modelCustom').focus()
    await expect.poll(() => modelCalls).toBe(2)
    releaseSecond?.()

    await expect(page.locator('#modelPreset')).toHaveValue('custom')
    await expect(page.locator('#modelCustom')).toBeVisible()
    assertNoErrors(harness)
  } finally {
    await closeExtension(harness.context, harness.userDataDir)
  }
})

test('options persists automation toggle without save', async ({
  browserName: _browserName,
}, testInfo) => {
  const harness = await launchExtension(getBrowserFromProject(testInfo.project.name))

  try {
    await seedSettings(harness, { automationEnabled: false })
    const page = await openExtensionPage(harness, 'options.html', '#tabs')

    const toggle = page.locator('#automationToggle .checkboxRoot')
    await toggle.click()

    await expect
      .poll(async () => {
        const settings = await getSettings(harness)
        return settings.automationEnabled
      })
      .toBe(true)

    await page.close()

    const reopened = await openExtensionPage(harness, 'options.html', '#tabs')
    const checked = await reopened.evaluate(() => {
      const input = document.querySelector('#automationToggle input') as HTMLInputElement | null
      return input?.checked ?? false
    })
    expect(checked).toBe(true)
    assertNoErrors(harness)
  } finally {
    await closeExtension(harness.context, harness.userDataDir)
  }
})

test('options disables automation permissions button when granted', async ({
  browserName: _browserName,
}, testInfo) => {
  const harness = await launchExtension(getBrowserFromProject(testInfo.project.name))

  try {
    await seedSettings(harness, { automationEnabled: true })
    const page = await harness.context.newPage()
    trackErrors(page, harness.pageErrors, harness.consoleErrors)
    await page.addInitScript(() => {
      Object.defineProperty(chrome, 'permissions', {
        configurable: true,
        value: {
          contains: async () => true,
          request: async () => true,
        },
      })
      Object.defineProperty(chrome, 'userScripts', {
        configurable: true,
        value: {},
      })
    })
    await page.goto(getExtensionUrl(harness, 'options.html'), {
      waitUntil: 'domcontentloaded',
    })
    await page.waitForSelector('#tabs')

    await expect(page.locator('#automationPermissions')).toBeDisabled()
    await expect(page.locator('#automationPermissions')).toHaveText(
      'Automation permissions granted'
    )
    await expect(page.locator('#userScriptsNotice')).toBeHidden()
    assertNoErrors(harness)
  } finally {
    await closeExtension(harness.context, harness.userDataDir)
  }
})

test('options shows user scripts guidance when unavailable', async ({
  browserName: _browserName,
}, testInfo) => {
  const harness = await launchExtension(getBrowserFromProject(testInfo.project.name))

  try {
    await seedSettings(harness, { automationEnabled: true })
    const page = await harness.context.newPage()
    trackErrors(page, harness.pageErrors, harness.consoleErrors)
    await page.addInitScript(() => {
      Object.defineProperty(chrome, 'permissions', {
        configurable: true,
        value: {
          contains: async () => false,
          request: async () => true,
        },
      })
      Object.defineProperty(chrome, 'userScripts', {
        configurable: true,
        value: undefined,
      })
    })
    await page.goto(getExtensionUrl(harness, 'options.html'), {
      waitUntil: 'domcontentloaded',
    })
    await page.waitForSelector('#tabs')

    await expect(page.locator('#automationPermissions')).toBeEnabled()
    await expect(page.locator('#automationPermissions')).toHaveText('Enable automation permissions')
    await expect(page.locator('#userScriptsNotice')).toBeVisible()
    await expect(page.locator('#userScriptsNotice')).toContainText(/User Scripts|chrome:\/\//)
    assertNoErrors(harness)
  } finally {
    await closeExtension(harness.context, harness.userDataDir)
  }
})

test('options scheme list renders chips', async ({ browserName: _browserName }, testInfo) => {
  const harness = await launchExtension(getBrowserFromProject(testInfo.project.name))

  try {
    const page = await openExtensionPage(harness, 'options.html', '#tabs')
    await page.click('#tab-ui')
    await expect(page.locator('#panel-ui')).toBeVisible()

    const schemeLabel = page.locator('label.scheme')
    const schemeTrigger = schemeLabel.locator('.pickerTrigger')

    await schemeTrigger.focus()
    await schemeTrigger.press('Enter')
    const schemeList = getOpenPickerList(page)
    await expect(schemeList).toBeVisible()

    const options = schemeList.locator('.pickerOption')
    await expect(options).toHaveCount(6)
    await expect(options.first().locator('.scheme-chips span')).toHaveCount(4)
    await expect(options.nth(1).locator('.scheme-chips span')).toHaveCount(4)

    assertNoErrors(harness)
  } finally {
    await closeExtension(harness.context, harness.userDataDir)
  }
})

test('options footer links to summarize site', async ({ browserName: _browserName }, testInfo) => {
  const harness = await launchExtension(getBrowserFromProject(testInfo.project.name))

  try {
    const page = await openExtensionPage(harness, 'options.html', '#tabs')
    const summarizeLink = page.locator('.pageFooter a', { hasText: 'Summarize' })
    await expect(summarizeLink).toHaveAttribute('href', /summarize\.sh/)
    assertNoErrors(harness)
  } finally {
    await closeExtension(harness.context, harness.userDataDir)
  }
})

test('sidepanel auto summarize toggle stays inline', async ({
  browserName: _browserName,
}, testInfo) => {
  const harness = await launchExtension(getBrowserFromProject(testInfo.project.name))

  try {
    await seedSettings(harness, { token: 'test-token' })
    await harness.context.route('http://127.0.0.1:8787/v1/models', async (route) => {
      await route.fulfill({
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          ok: true,
          options: [],
          providers: {},
          localModelsSource: null,
        }),
      })
    })
    const page = await openExtensionPage(harness, 'sidepanel.html', '#title')
    await page.click('#drawerToggle')
    await expect(page.locator('#drawer')).toBeVisible()
    await page.click('#advancedSettings > summary')
    await expect(page.locator('#advancedSettings')).toHaveJSProperty('open', true)

    const label = page.locator('#autoToggle .checkboxRoot')
    await expect(label).toBeVisible()
    const labelBox = await label.boundingBox()
    const controlBox = await page.locator('#autoToggle .checkboxControl').boundingBox()
    const textBox = await page.locator('#autoToggle .checkboxLabel').boundingBox()

    expect(labelBox).not.toBeNull()
    expect(controlBox).not.toBeNull()
    expect(textBox).not.toBeNull()

    if (labelBox && controlBox && textBox) {
      expect(controlBox.y).toBeGreaterThanOrEqual(labelBox.y - 1)
      expect(controlBox.y).toBeLessThanOrEqual(labelBox.y + labelBox.height - 1)
      expect(textBox.y).toBeGreaterThanOrEqual(labelBox.y - 1)
      expect(textBox.y).toBeLessThanOrEqual(labelBox.y + labelBox.height - 1)
    }

    assertNoErrors(harness)
  } finally {
    await closeExtension(harness.context, harness.userDataDir)
  }
})
