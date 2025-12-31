import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import type { BrowserContext, Page, Worker } from '@playwright/test'
import { chromium, expect, test } from '@playwright/test'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const extensionPath = path.resolve(__dirname, '..', '.output', 'chrome-mv3')
const consoleErrorAllowlist: RegExp[] = []

type ExtensionHarness = {
  context: BrowserContext
  extensionId: string
  pageErrors: Error[]
  consoleErrors: string[]
  userDataDir: string
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

async function launchExtension(): Promise<ExtensionHarness> {
  if (!fs.existsSync(extensionPath)) {
    throw new Error('Missing built extension. Run: pnpm -C apps/chrome-extension build')
  }

  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'summarize-ext-'))
  // Chromium extensions (MV3 service workers) are not reliably supported in headless mode.
  // Default: keep UI out of the way; set SHOW_UI=1 for debugging.
  const showUi = process.env.SHOW_UI === '1'
  const hideUi = !showUi
  const args = [
    ...(hideUi
      ? ['--start-minimized', '--window-position=-10000,-10000', '--window-size=10,10']
      : []),
    `--disable-extensions-except=${extensionPath}`,
    `--load-extension=${extensionPath}`,
  ]
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    args,
  })
  await context.route('**/favicon.ico', async (route) => {
    await route.fulfill({ status: 204, body: '' })
  })

  const background =
    context.serviceWorkers()[0] ??
    (await context.waitForEvent('serviceworker', { timeout: 15_000 }))
  const extensionId = new URL(background.url()).host

  return {
    context,
    extensionId,
    pageErrors: [],
    consoleErrors: [],
    userDataDir,
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

async function mockDaemonSummarize(harness: ExtensionHarness) {
  const background = await getBackground(harness)
  await background.evaluate(() => {
    const originalFetch =
      (globalThis.__originalFetch as typeof globalThis.fetch | undefined) ?? globalThis.fetch
    globalThis.__originalFetch = originalFetch
    if (typeof globalThis.__summarizeCalls !== 'number') {
      globalThis.__summarizeCalls = 0
    }
    globalThis.__summarizeLastBody = null
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
        const body = typeof init?.body === 'string' ? init.body : null
        if (body) {
          try {
            globalThis.__summarizeLastBody = JSON.parse(body)
          } catch {
            globalThis.__summarizeLastBody = null
          }
        }
        return new Response(
          JSON.stringify({ ok: true, id: `run-${globalThis.__summarizeCalls}` }),
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

async function getSummarizeLastBody(harness: ExtensionHarness) {
  const background =
    harness.context.serviceWorkers()[0] ??
    (await harness.context.waitForEvent('serviceworker', { timeout: 15_000 }))
  return background.evaluate(() => globalThis.__summarizeLastBody ?? null)
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
  readySelector: string
) {
  const page = await harness.context.newPage()
  trackErrors(page, harness.pageErrors, harness.consoleErrors)
  await page.goto(`chrome-extension://${harness.extensionId}/${pathname}`, {
    waitUntil: 'domcontentloaded',
  })
  await page.waitForSelector(readySelector)
  return page
}

async function closeExtension(context: BrowserContext, userDataDir: string) {
  await context.close()
  fs.rmSync(userDataDir, { recursive: true, force: true })
}

test('sidepanel loads without runtime errors', async () => {
  const harness = await launchExtension()

  try {
    await openExtensionPage(harness, 'sidepanel.html', '#title')
    await new Promise((resolve) => setTimeout(resolve, 500))
    assertNoErrors(harness)
  } finally {
    await closeExtension(harness.context, harness.userDataDir)
  }
})

test('sidepanel hides chat dock when chat is disabled', async () => {
  const harness = await launchExtension()

  try {
    await seedSettings(harness, { chatEnabled: false })
    const page = await openExtensionPage(harness, 'sidepanel.html', '#title')
    await expect(page.locator('#chatDock')).toBeHidden()
    await expect(page.locator('#chatContainer')).toBeHidden()
    assertNoErrors(harness)
  } finally {
    await closeExtension(harness.context, harness.userDataDir)
  }
})

test('sidepanel updates chat visibility when settings change', async () => {
  const harness = await launchExtension()

  try {
    await seedSettings(harness, { chatEnabled: true })
    const page = await openExtensionPage(harness, 'sidepanel.html', '#title')
    await expect(page.locator('#chatDock')).toBeVisible()

    await seedSettings(harness, { chatEnabled: false })
    await expect(page.locator('#chatDock')).toBeHidden()
    await expect(page.locator('#chatContainer')).toBeHidden()
    assertNoErrors(harness)
  } finally {
    await closeExtension(harness.context, harness.userDataDir)
  }
})

test('sidepanel scheme picker supports keyboard selection', async () => {
  const harness = await launchExtension()

  try {
    const page = await openExtensionPage(harness, 'sidepanel.html', '#title')
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

test('sidepanel refresh free models from advanced settings', async () => {
  const harness = await launchExtension()

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

test('sidepanel refresh free shows error on failure', async () => {
  const harness = await launchExtension()

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

test('sidepanel mode picker updates theme mode', async () => {
  const harness = await launchExtension()

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

test('sidepanel custom length input accepts typing', async () => {
  const harness = await launchExtension()

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

test('sidepanel updates title after stream when tab title changes', async () => {
  const harness = await launchExtension()

  try {
    await mockDaemonSummarize(harness)
    await seedSettings(harness, { token: 'test-token' })
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

test('sidepanel clears summary when tab url changes', async () => {
  const harness = await launchExtension()

  try {
    await mockDaemonSummarize(harness)
    await seedSettings(harness, { token: 'test-token' })
    const page = await openExtensionPage(harness, 'sidepanel.html', '#title')
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

    await sendBgMessage(harness, {
      type: 'run:start',
      run: {
        id: 'run-2',
        url: 'https://example.com/old',
        title: 'Old Title',
        model: 'auto',
        reason: 'manual',
      },
    })

    await expect(page.locator('#title')).toHaveText('Old Title')
    await page.evaluate(() => {
      const render = document.getElementById('render')
      if (render) render.innerHTML = '<p>Hello world</p>'
    })
    await expect(page.locator('#render')).toContainText('Hello world')

    await sendBgMessage(harness, {
      type: 'ui:state',
      state: buildUiState({
        tab: { url: 'https://example.com/new', title: 'New Title' },
        status: '',
      }),
    })

    await expect(page.locator('#title')).toHaveText('New Title')
    await expect(page.locator('#render')).toBeEmpty()
    assertNoErrors(harness)
  } finally {
    await closeExtension(harness.context, harness.userDataDir)
  }
})

test('sidepanel video selection forces transcript mode', async () => {
  const harness = await launchExtension()

  try {
    await mockDaemonSummarize(harness)
    await seedSettings(harness, { token: 'test-token', autoSummarize: false })
    const contentPage = await harness.context.newPage()
    await contentPage.goto('https://example.com', { waitUntil: 'domcontentloaded' })
    await contentPage.evaluate(() => {
      document.body.innerHTML = `<article><p>${'Hello '.repeat(40)}</p></article>`
    })
    await contentPage.bringToFront()
    await activateTabByUrl(harness, 'https://example.com')
    await waitForActiveTabUrl(harness, 'https://example.com')
    await injectContentScript(harness, 'content-scripts/extract.js', 'https://example.com')

    const page = await openExtensionPage(harness, 'sidepanel.html', '#title')
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

    await contentPage.bringToFront()
    await activateTabByUrl(harness, 'https://example.com')
    await waitForActiveTabUrl(harness, 'https://example.com')

    await sendPanelMessage(page, { type: 'panel:summarize', inputMode: 'video', refresh: false })
    await expect.poll(() => getSummarizeCalls(harness)).toBe(1)

    const body = (await getSummarizeLastBody(harness)) as Record<string, unknown> | null
    expect(body?.mode).toBe('url')
    expect(body?.videoMode).toBe('transcript')
    assertNoErrors(harness)
  } finally {
    await closeExtension(harness.context, harness.userDataDir)
  }
})

test('sidepanel shows an error when agent request fails', async () => {
  const harness = await launchExtension()

  try {
    await seedSettings(harness, { token: 'test-token', autoSummarize: false, chatEnabled: true })
    const contentPage = await harness.context.newPage()
    await contentPage.goto('https://example.com', { waitUntil: 'domcontentloaded' })
    await contentPage.evaluate(() => {
      document.body.innerHTML = `<article><p>Agent error test.</p></article>`
    })
    await contentPage.bringToFront()
    await activateTabByUrl(harness, 'https://example.com')
    await waitForActiveTabUrl(harness, 'https://example.com')
    await injectContentScript(harness, 'content-scripts/extract.js', 'https://example.com')

    await harness.context.route('http://127.0.0.1:8787/v1/agent', async (route) => {
      await route.fulfill({
        status: 500,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ok: false, error: 'Boom' }),
      })
    })

    const page = await openExtensionPage(harness, 'sidepanel.html', '#title')
    await page.evaluate((value) => {
      const input = document.getElementById('chatInput') as HTMLTextAreaElement | null
      const send = document.getElementById('chatSend') as HTMLButtonElement | null
      if (!input || !send) return
      input.value = value
      input.dispatchEvent(new Event('input', { bubbles: true }))
      send.click()
    }, 'Trigger agent error')

    await expect(page.locator('#error')).toBeVisible()
    await expect(page.locator('#errorMessage')).toContainText('Chat request failed')
    assertNoErrors(harness)
  } finally {
    await closeExtension(harness.context, harness.userDataDir)
  }
})

test('sidepanel shows daemon upgrade hint when /v1/agent is missing', async () => {
  const harness = await launchExtension()

  try {
    await seedSettings(harness, { token: 'test-token', autoSummarize: false, chatEnabled: true })
    const contentPage = await harness.context.newPage()
    await contentPage.goto('https://example.com', { waitUntil: 'domcontentloaded' })
    await contentPage.evaluate(() => {
      document.body.innerHTML = `<article><p>Agent 404 test.</p></article>`
    })
    await contentPage.bringToFront()
    await activateTabByUrl(harness, 'https://example.com')
    await waitForActiveTabUrl(harness, 'https://example.com')
    await injectContentScript(harness, 'content-scripts/extract.js', 'https://example.com')

    await harness.context.route('http://127.0.0.1:8787/v1/agent', async (route) => {
      await route.fulfill({
        status: 404,
        headers: { 'content-type': 'text/plain' },
        body: 'Not Found',
      })
    })

    const page = await openExtensionPage(harness, 'sidepanel.html', '#title')
    await page.evaluate((value) => {
      const input = document.getElementById('chatInput') as HTMLTextAreaElement | null
      const send = document.getElementById('chatSend') as HTMLButtonElement | null
      if (!input || !send) return
      input.value = value
      input.dispatchEvent(new Event('input', { bubbles: true }))
      send.click()
    }, 'Trigger agent 404')

    await expect(page.locator('#error')).toBeVisible()
    await expect(page.locator('#errorMessage')).toContainText('Daemon does not support /v1/agent')
    assertNoErrors(harness)
  } finally {
    await closeExtension(harness.context, harness.userDataDir)
  }
})

test('sidepanel chat queue sends next message after stream completes', async () => {
  const harness = await launchExtension()

  try {
    await seedSettings(harness, { token: 'test-token', autoSummarize: false, chatEnabled: true })
    const contentPage = await harness.context.newPage()
    await contentPage.goto('https://example.com', { waitUntil: 'domcontentloaded' })
    await contentPage.evaluate(() => {
      document.body.innerHTML = `<article><p>${'Hello '.repeat(40)}</p><p>More text for chat.</p></article>`
    })
    await contentPage.bringToFront()
    await activateTabByUrl(harness, 'https://example.com')
    await waitForActiveTabUrl(harness, 'https://example.com')
    await injectContentScript(harness, 'content-scripts/extract.js', 'https://example.com')

    const page = await openExtensionPage(harness, 'sidepanel.html', '#title')

    let agentRequestCount = 0
    let releaseFirst: (() => void) | null = null
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })

    await harness.context.route('http://127.0.0.1:8787/v1/agent', async (route) => {
      agentRequestCount += 1
      if (agentRequestCount === 1) await firstGate
      await route.fulfill({
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ok: true, assistant: buildAssistant(`Reply ${agentRequestCount}`) }),
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

    await contentPage.bringToFront()
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

test('sidepanel chat queue drains messages after stream completes', async () => {
  const harness = await launchExtension()

  try {
    await seedSettings(harness, { token: 'test-token', autoSummarize: false, chatEnabled: true })
    const contentPage = await harness.context.newPage()
    await contentPage.goto('https://example.com', { waitUntil: 'domcontentloaded' })
    await contentPage.evaluate(() => {
      document.body.innerHTML = `<article><p>${'Hello '.repeat(40)}</p><p>More text for chat.</p></article>`
    })
    await contentPage.bringToFront()
    await activateTabByUrl(harness, 'https://example.com')
    await waitForActiveTabUrl(harness, 'https://example.com')
    await injectContentScript(harness, 'content-scripts/extract.js', 'https://example.com')

    const page = await openExtensionPage(harness, 'sidepanel.html', '#title')

    let agentRequestCount = 0
    let releaseFirst: (() => void) | null = null
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })

    await harness.context.route('http://127.0.0.1:8787/v1/agent', async (route) => {
      agentRequestCount += 1
      if (agentRequestCount === 1) await firstGate
      await route.fulfill({
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ok: true, assistant: buildAssistant(`Reply ${agentRequestCount}`) }),
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

    await contentPage.bringToFront()
    await activateTabByUrl(harness, 'https://example.com')
    await waitForActiveTabUrl(harness, 'https://example.com')
    await sendChat('First question')
    await expect.poll(() => agentRequestCount).toBe(1)
    await sendChat('Second question')
    await sendChat('Third question')

    await expect.poll(() => agentRequestCount, { timeout: 1_000 }).toBe(1)

    releaseFirst?.()

    await expect.poll(() => agentRequestCount).toBe(3)
    await expect(page.locator('#chatMessages')).toContainText('Second question')
    await expect(page.locator('#chatMessages')).toContainText('Third question')

    assertNoErrors(harness)
  } finally {
    await closeExtension(harness.context, harness.userDataDir)
  }
})

test('sidepanel clears chat on user navigation', async () => {
  const harness = await launchExtension()

  try {
    await seedSettings(harness, { token: 'test-token', autoSummarize: false, chatEnabled: true })
    const contentPage = await harness.context.newPage()
    await contentPage.goto('https://example.com', { waitUntil: 'domcontentloaded' })
    await contentPage.evaluate(() => {
      document.body.innerHTML = `<article><p>Chat nav test.</p></article>`
    })
    await contentPage.bringToFront()
    await activateTabByUrl(harness, 'https://example.com')
    await waitForActiveTabUrl(harness, 'https://example.com')
    await injectContentScript(harness, 'content-scripts/extract.js', 'https://example.com')

    await harness.context.route('http://127.0.0.1:8787/v1/agent', async (route) => {
      await route.fulfill({
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ok: true, assistant: buildAssistant('Ack') }),
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

test('auto summarize reruns after panel reopen', async () => {
  const harness = await launchExtension()

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
    await contentPage.bringToFront()
    await activateTabByUrl(harness, 'https://example.com')
    await waitForActiveTabUrl(harness, 'https://example.com')

    const panel = await openExtensionPage(harness, 'sidepanel.html', '#title')
    await contentPage.bringToFront()
    await activateTabByUrl(harness, 'https://example.com')
    await waitForActiveTabUrl(harness, 'https://example.com')
    await mockDaemonSummarize(harness)
    await sendPanelMessage(panel, { type: 'panel:ready' })
    await expect.poll(async () => await getSummarizeCalls(harness)).toBeGreaterThanOrEqual(1)
    await sendPanelMessage(panel, { type: 'panel:rememberUrl', url: activeUrl })

    const callsBeforeClose = await getSummarizeCalls(harness)
    await sendPanelMessage(panel, { type: 'panel:closed' })
    await contentPage.bringToFront()
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

test('sidepanel updates title while streaming on same URL', async () => {
  const harness = await launchExtension()

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

test('hover tooltip proxies daemon calls via background (no page-origin localhost fetch)', async () => {
  test.setTimeout(30_000)
  const harness = await launchExtension()

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
    await page.bringToFront()
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

test('content script extracts visible duration metadata', async () => {
  test.setTimeout(45_000)
  const harness = await launchExtension()

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

test('options pickers support keyboard selection', async () => {
  const harness = await launchExtension()

  try {
    const page = await openExtensionPage(harness, 'options.html', '#pickersRoot')

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

test('options keeps custom model selected while presets refresh', async () => {
  const harness = await launchExtension()

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

    const page = await openExtensionPage(harness, 'options.html', '#pickersRoot')
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

test('options persists automation toggle without save', async () => {
  const harness = await launchExtension()

  try {
    await seedSettings(harness, { automationEnabled: false })
    const page = await openExtensionPage(harness, 'options.html', '#pickersRoot')

    const toggle = page.locator('#automationToggle .checkboxRoot')
    await toggle.click()

    await expect
      .poll(async () => {
        const settings = await getSettings(harness)
        return settings.automationEnabled
      })
      .toBe(true)

    await page.close()

    const reopened = await openExtensionPage(harness, 'options.html', '#pickersRoot')
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

test('options disables automation permissions button when granted', async () => {
  const harness = await launchExtension()

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
    await page.goto(`chrome-extension://${harness.extensionId}/options.html`, {
      waitUntil: 'domcontentloaded',
    })
    await page.waitForSelector('#pickersRoot')

    await expect(page.locator('#automationPermissions')).toBeDisabled()
    await expect(page.locator('#automationPermissions')).toHaveText('Automation permissions granted')
    await expect(page.locator('#userScriptsNotice')).toBeHidden()
    assertNoErrors(harness)
  } finally {
    await closeExtension(harness.context, harness.userDataDir)
  }
})

test('options shows user scripts guidance when unavailable', async () => {
  const harness = await launchExtension()

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
    await page.goto(`chrome-extension://${harness.extensionId}/options.html`, {
      waitUntil: 'domcontentloaded',
    })
    await page.waitForSelector('#pickersRoot')

    await expect(page.locator('#automationPermissions')).toBeEnabled()
    await expect(page.locator('#automationPermissions')).toHaveText('Enable automation permissions')
    await expect(page.locator('#userScriptsNotice')).toBeVisible()
    await expect(page.locator('#userScriptsNotice')).toContainText('User Scripts API is not available')
    assertNoErrors(harness)
  } finally {
    await closeExtension(harness.context, harness.userDataDir)
  }
})

test('options scheme list renders chips', async () => {
  const harness = await launchExtension()

  try {
    const page = await openExtensionPage(harness, 'options.html', '#pickersRoot')

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

test('options footer links to summarize site', async () => {
  const harness = await launchExtension()

  try {
    const page = await openExtensionPage(harness, 'options.html', '#pickersRoot')
    const summarizeLink = page.locator('.pageFooter a', { hasText: 'Summarize' })
    await expect(summarizeLink).toHaveAttribute('href', /summarize\.sh/)
    assertNoErrors(harness)
  } finally {
    await closeExtension(harness.context, harness.userDataDir)
  }
})

test('sidepanel auto summarize toggle stays inline', async () => {
  const harness = await launchExtension()

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
