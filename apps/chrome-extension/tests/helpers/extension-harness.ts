import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AssistantMessage, Message } from "@mariozechner/pi-ai";
import type { BrowserContext, Page, Worker } from "@playwright/test";
import { chromium, expect, firefox } from "@playwright/test";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const consoleErrorAllowlist: RegExp[] = [];
const showUi = process.env.SHOW_UI === "1";

export type BrowserType = "chromium" | "firefox";

export type ExtensionHarness = {
  context: BrowserContext;
  extensionId: string;
  pageErrors: Error[];
  consoleErrors: string[];
  userDataDir: string;
  browser: BrowserType;
};

export type UiState = {
  panelOpen: boolean;
  daemon: { ok: boolean; authed: boolean; error?: string };
  tab: { id: number | null; url: string | null; title: string | null };
  media: { hasVideo: boolean; hasAudio: boolean; hasCaptions: boolean } | null;
  stats: { pageWords: number | null; videoDurationSeconds: number | null };
  settings: {
    autoSummarize: boolean;
    hoverSummaries: boolean;
    chatEnabled: boolean;
    automationEnabled: boolean;
    slidesEnabled: boolean;
    slidesParallel: boolean;
    slidesOcrEnabled: boolean;
    slidesLayout?: "strip" | "gallery";
    model: string;
    length: string;
    tokenPresent: boolean;
  };
  status: string;
};

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
    slidesLayout: "strip",
    model: "auto",
    length: "xl",
    tokenPresent: true,
  },
  status: "",
};

export function buildUiState(overrides: Partial<UiState>): UiState {
  return {
    ...defaultUiState,
    ...overrides,
    daemon: { ...defaultUiState.daemon, ...overrides.daemon },
    tab: { ...defaultUiState.tab, ...overrides.tab },
    settings: { ...defaultUiState.settings, ...overrides.settings },
  };
}

export function buildAssistant(text: string): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    timestamp: Date.now(),
    api: "openai-completions",
    provider: "openai",
    model: "test",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
  };
}

export function buildAgentStream(text: string) {
  const assistant = buildAssistant(text);
  return [
    "event: chunk",
    `data: ${JSON.stringify({ text })}`,
    "",
    "event: assistant",
    `data: ${JSON.stringify(assistant)}`,
    "",
    "event: done",
    "data: {}",
    "",
  ].join("\n");
}

function filterAllowed(errors: string[]) {
  return errors.filter(
    (message) => !consoleErrorAllowlist.some((pattern) => pattern.test(message)),
  );
}

export function trackErrors(page: Page, pageErrors: Error[], consoleErrors: string[]) {
  page.on("pageerror", (error) => pageErrors.push(error));
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    consoleErrors.push(message.text());
  });
}

export function assertNoErrors(harness: ExtensionHarness) {
  expect(harness.pageErrors.map((error) => error.message)).toEqual([]);
  expect(filterAllowed(harness.consoleErrors)).toEqual([]);
}

export function getOpenPickerList(page: Page) {
  return page.locator("#summarize-overlay-root .pickerContent:not([hidden]) .pickerList");
}

export async function maybeBringToFront(page: Page) {
  if (!showUi) return;
  await page.bringToFront();
}

export function getExtensionPath(browser: BrowserType): string {
  const outputDir = browser === "firefox" ? "firefox-mv3" : "chrome-mv3";
  return path.resolve(__dirname, "..", "..", ".output", outputDir);
}

function getExtensionUrlScheme(browser: BrowserType): string {
  return browser === "firefox" ? "moz-extension" : "chrome-extension";
}

export function getExtensionUrl(harness: ExtensionHarness, pathname: string): string {
  const scheme = getExtensionUrlScheme(harness.browser);
  return `${scheme}://${harness.extensionId}/${pathname}`;
}

export function getBrowserFromProject(projectName: string): BrowserType {
  return projectName === "firefox" ? "firefox" : "chromium";
}

export async function launchExtension(
  browser: BrowserType = "chromium",
): Promise<ExtensionHarness> {
  const extensionPath = getExtensionPath(browser);

  if (!fs.existsSync(extensionPath)) {
    const buildCmd =
      browser === "firefox"
        ? "pnpm -C apps/chrome-extension build:firefox"
        : "pnpm -C apps/chrome-extension build";
    throw new Error(`Missing built extension. Run: ${buildCmd}`);
  }

  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "summarize-ext-"));
  const headless = !showUi && process.env.HEADLESS !== "0";
  const hideUi = !showUi && !headless;

  const browserType = browser === "firefox" ? firefox : chromium;
  const args = [
    ...(hideUi
      ? ["--start-minimized", "--window-position=-10000,-10000", "--window-size=10,10"]
      : []),
    `--disable-extensions-except=${extensionPath}`,
    `--load-extension=${extensionPath}`,
  ];

  const context = await browserType.launchPersistentContext(userDataDir, {
    ...(browser === "chromium" ? { channel: "chromium" } : {}),
    headless,
    args,
  });
  await context.route("**/favicon.ico", async (route) => {
    await route.fulfill({ status: 204, body: "" });
  });
  await context.route("http://127.0.0.1:8787/v1/agent/history", async (route) => {
    await route.fulfill({
      status: 200,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ok: true, messages: null }),
    });
  });

  let extensionId: string;

  if (browser === "firefox") {
    const manifestPath = path.join(extensionPath, "manifest.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    extensionId =
      manifest.browser_specific_settings?.gecko?.id || manifest.applications?.gecko?.id || "";
    if (!extensionId) {
      throw new Error(
        "Firefox extension missing explicit ID in manifest. This should be set via browser_specific_settings.gecko.id in wxt.config.ts",
      );
    }
  } else {
    const background =
      context.serviceWorkers()[0] ??
      (await context.waitForEvent("serviceworker", { timeout: 15_000 }));
    extensionId = new URL(background.url()).host;
  }

  return {
    context,
    extensionId,
    pageErrors: [],
    consoleErrors: [],
    userDataDir,
    browser,
  };
}

export async function getBackground(harness: ExtensionHarness): Promise<Worker> {
  return (
    harness.context.serviceWorkers()[0] ??
    (await harness.context.waitForEvent("serviceworker", { timeout: 15_000 }))
  );
}

export async function sendBgMessage(harness: ExtensionHarness, message: object) {
  const background = await getBackground(harness);
  const applyToOpenPanel = async () => {
    const extensionPrefix = getExtensionUrl(harness, "");
    for (const page of harness.context.pages()) {
      if (!page.url().startsWith(extensionPrefix)) continue;
      const applied = await page
        .evaluate((payload) => {
          const hooks = (
            window as typeof globalThis & {
              __summarizeTestHooks?: { applyBgMessage?: (value: object) => void };
            }
          ).__summarizeTestHooks;
          if (typeof hooks?.applyBgMessage !== "function") return false;
          hooks.applyBgMessage(payload);
          return true;
        }, message)
        .catch(() => false);
      if (applied) return true;
    }
    return false;
  };
  await expect
    .poll(async () => {
      const hasPort = await background.evaluate(() => {
        const ports = (
          globalThis as typeof globalThis & {
            __summarizePanelPorts?: Map<number, { postMessage: (msg: object) => void }>;
          }
        ).__summarizePanelPorts;
        return Boolean(ports && ports.size > 0);
      });
      if (hasPort) return true;
      return await applyToOpenPanel();
    })
    .toBe(true);
  const sent = await background.evaluate((payload) => {
    const global = globalThis as typeof globalThis & {
      __summarizePanelPorts?: Map<number, { postMessage: (msg: object) => void }>;
    };
    const ports = global.__summarizePanelPorts;
    if (ports && ports.size > 0) {
      const first = ports.values().next().value;
      if (first?.postMessage) {
        first.postMessage(payload);
        return true;
      }
    }
    return false;
  }, message);
  if (sent) return;
  const applied = await applyToOpenPanel();
  if (applied) return;
  throw new Error("Failed to deliver background message to sidepanel");
}

export async function sendPanelMessage(page: Page, message: object) {
  await waitForPanelPort(page);
  const portName = await page.evaluate(() => {
    const port = (
      window as {
        __summarizePanelPort?: { name?: string; postMessage?: (value: object) => void };
      }
    ).__summarizePanelPort;
    return typeof port?.name === "string" ? port.name : null;
  });
  const windowId =
    portName && portName.startsWith("sidepanel:")
      ? Number.parseInt(portName.slice("sidepanel:".length), 10)
      : Number.NaN;
  const background =
    page.context().serviceWorkers()[0] ??
    (await page.context().waitForEvent("serviceworker", { timeout: 5_000 }));

  if (Number.isFinite(windowId)) {
    const sent = await background.evaluate(
      ({ payload, targetWindowId }) => {
        const dispatch = (
          globalThis as typeof globalThis & {
            __summarizeDispatchPanelMessage?: (windowId: number, msg: object) => boolean;
          }
        ).__summarizeDispatchPanelMessage;
        if (typeof dispatch !== "function") return false;
        return dispatch(targetWindowId, payload);
      },
      { payload: message, targetWindowId: windowId },
    );
    if (sent) return;
  }

  await page.evaluate((payload) => {
    const port = (
      window as {
        __summarizePanelPort?: { postMessage: (value: object) => void };
      }
    ).__summarizePanelPort;
    if (!port) throw new Error("Missing panel port");
    port.postMessage(payload);
  }, message);
}

export async function waitForPanelPort(page: Page) {
  await page.waitForFunction(
    () =>
      typeof (window as { __summarizePanelPort?: { postMessage?: unknown } }).__summarizePanelPort
        ?.postMessage === "function",
    null,
    { timeout: 5_000 },
  );
}

export async function injectContentScript(
  harness: ExtensionHarness,
  file: string,
  urlPrefix?: string,
) {
  const background = await getBackground(harness);
  const result = await Promise.race([
    background.evaluate(
      async ({ scriptFile, prefix }) => {
        const tabs = await chrome.tabs.query({});
        const target =
          prefix && prefix.length > 0
            ? tabs.find((tab) => tab.url?.startsWith(prefix))
            : (tabs.find((tab) => tab.active) ?? tabs[0]);
        if (!target?.id) return { ok: false, error: "missing tab" };
        await chrome.scripting.executeScript({
          target: { tabId: target.id },
          files: [scriptFile],
        });
        return { ok: true };
      },
      { scriptFile: file, prefix: urlPrefix ?? "" },
    ),
    new Promise<{ ok: false; error: string }>((resolve) =>
      setTimeout(() => resolve({ ok: false, error: "inject timeout" }), 5_000),
    ),
  ]);

  if (!result?.ok) {
    throw new Error(`Failed to inject ${file}: ${result?.error ?? "unknown error"}`);
  }
}

export async function waitForExtractReady(
  harness: ExtensionHarness,
  urlPrefix: string,
  maxChars = 1200,
) {
  const background = await getBackground(harness);
  await expect
    .poll(async () => {
      return await background.evaluate(
        async ({ prefix, limit }) => {
          const tabs = await chrome.tabs.query({});
          const target = tabs.find((tab) => tab.url?.startsWith(prefix));
          if (!target?.id) return false;
          try {
            const res = (await chrome.tabs.sendMessage(target.id, {
              type: "extract",
              maxChars: limit,
            })) as { ok?: boolean };
            return Boolean(res?.ok);
          } catch {
            return false;
          }
        },
        { prefix: urlPrefix, limit: maxChars },
      );
    })
    .toBe(true);
}

export async function seedSettings(harness: ExtensionHarness, settings: Record<string, unknown>) {
  const background = await getBackground(harness);
  await background.evaluate(async (payload) => {
    await new Promise<void>((resolve) => {
      chrome.storage.local.set({ settings: payload }, () => resolve());
    });
  }, settings);
}

export async function updateSettings(page: Page, patch: Record<string, unknown>) {
  await page.evaluate(async (nextSettings) => {
    const current = await new Promise<Record<string, unknown>>((resolve) => {
      chrome.storage.local.get("settings", (result) => {
        resolve((result?.settings as Record<string, unknown>) ?? {});
      });
    });
    const merged = { ...current, ...nextSettings };
    await new Promise<void>((resolve) => {
      chrome.storage.local.set({ settings: merged }, () => resolve());
    });
  }, patch);
}

export async function getSettings(harness: ExtensionHarness) {
  const background = await getBackground(harness);
  return await background.evaluate(async () => {
    return await new Promise<Record<string, unknown>>((resolve) => {
      chrome.storage.local.get("settings", (result) => {
        resolve((result?.settings as Record<string, unknown>) ?? {});
      });
    });
  });
}

export async function getActiveTabUrl(harness: ExtensionHarness) {
  const background = await getBackground(harness);
  return await background.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (tab?.url) return tab.url;
    const [fallback] = await chrome.tabs.query({ active: true });
    if (fallback?.url) return fallback.url;
    const tabs = await chrome.tabs.query({});
    const contentTab = tabs.find(
      (candidate) =>
        typeof candidate.url === "string" &&
        !candidate.url.startsWith("chrome-extension://") &&
        !candidate.url.startsWith("chrome://"),
    );
    if (contentTab?.url) return contentTab.url;
    return tab?.url ?? null;
  });
}

export async function getActiveTabId(harness: ExtensionHarness) {
  const background = await getBackground(harness);
  return await background.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (typeof tab?.id === "number") return tab.id;
    const [fallback] = await chrome.tabs.query({ active: true });
    if (typeof fallback?.id === "number") return fallback.id;
    return tab?.id ?? null;
  });
}

export async function waitForActiveTabUrl(harness: ExtensionHarness, expectedPrefix: string) {
  await expect.poll(async () => (await getActiveTabUrl(harness)) ?? "").toContain(expectedPrefix);
}

export async function activateTabByUrl(harness: ExtensionHarness, expectedPrefix: string) {
  const background = await getBackground(harness);
  await background.evaluate(async (prefix) => {
    const tabs = await chrome.tabs.query({});
    const target = tabs.find((tab) => tab.url?.startsWith(prefix));
    if (!target?.id) return;
    if (typeof target.windowId === "number") {
      await chrome.windows.update(target.windowId, { focused: true }).catch(() => {});
    }
    await chrome.tabs.update(target.id, { active: true });
  }, expectedPrefix);
}

export async function openExtensionPage(
  harness: ExtensionHarness,
  pathname: string,
  readySelector: string,
  initScript?: () => void,
) {
  const page = await harness.context.newPage();
  trackErrors(page, harness.pageErrors, harness.consoleErrors);
  await page.addInitScript(() => {
    (
      window as typeof globalThis & { __summarizeTestHooks?: Record<string, unknown> }
    ).__summarizeTestHooks = {};
  });
  if (initScript) {
    await page.addInitScript(initScript);
  }
  await page.goto(getExtensionUrl(harness, pathname), {
    waitUntil: "domcontentloaded",
  });
  await page.waitForSelector(readySelector);
  return page;
}

export async function closeExtension(context: BrowserContext, userDataDir: string) {
  await context.close();
  fs.rmSync(userDataDir, { recursive: true, force: true });
}

export type ChatLikeMessage = Message;
