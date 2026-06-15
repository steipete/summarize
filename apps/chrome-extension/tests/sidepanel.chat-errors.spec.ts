import { expect, test } from "@playwright/test";
import { mockDaemonSummarize } from "./helpers/daemon-fixtures";
import {
  activateTabByUrl,
  assertNoErrors,
  buildUiState,
  closeExtension,
  getActiveTabId,
  getBrowserFromProject,
  injectContentScript,
  launchExtension,
  maybeBringToFront,
  openExtensionPage,
  seedSettings,
  sendBgMessage,
  waitForActiveTabUrl,
  waitForExtractReady,
  waitForPanelPort,
} from "./helpers/extension-harness";
import { allowFirefoxExtensionTests } from "./helpers/extension-test-config";
import { waitForSettingsHydratedHook } from "./helpers/panel-hooks";

test.skip(
  ({ browserName }) => browserName === "firefox" && !allowFirefoxExtensionTests,
  "Firefox extension tests are blocked by Playwright limitations. Set ALLOW_FIREFOX_EXTENSION_TESTS=1 to run.",
);

test("sidepanel shows an error when agent request fails", async ({
  browserName: _browserName,
}, testInfo) => {
  const harness = await launchExtension(getBrowserFromProject(testInfo.project.name));

  try {
    await mockDaemonSummarize(harness);
    await seedSettings(harness, {
      token: "test-token",
      summaryRuntime: "daemon",
      autoSummarize: false,
      chatEnabled: true,
    });
    const contentPage = await harness.context.newPage();
    await contentPage.goto("https://example.com", { waitUntil: "domcontentloaded" });
    await contentPage.evaluate(() => {
      document.body.innerHTML = `<article><p>${"Agent error test. ".repeat(12)}</p></article>`;
    });
    await maybeBringToFront(contentPage);
    await activateTabByUrl(harness, "https://example.com");
    await waitForActiveTabUrl(harness, "https://example.com");
    await injectContentScript(harness, "content-scripts/extract.js", "https://example.com");
    await waitForExtractReady(harness, "https://example.com");

    let agentCalls = 0;
    await harness.context.route("http://127.0.0.1:8787/v1/agent", async (route) => {
      agentCalls += 1;
      await route.fulfill({
        status: 500,
        headers: { "content-type": "text/plain" },
        body: "Boom",
      });
    });

    const page = await openExtensionPage(harness, "sidepanel.html", "#title");
    await waitForPanelPort(page);
    await waitForSettingsHydratedHook(page);
    await maybeBringToFront(contentPage);
    await activateTabByUrl(harness, "https://example.com");
    await waitForActiveTabUrl(harness, "https://example.com");
    const activeTabId = await getActiveTabId(harness);
    await sendBgMessage(harness, {
      type: "ui:state",
      state: buildUiState({
        tab: { id: activeTabId, url: "https://example.com", title: "Example" },
        settings: {
          chatEnabled: true,
          summaryRuntime: "daemon",
          tokenPresent: true,
        },
      }),
    });

    await expect(page.locator("#chatSend")).toBeEnabled();
    await page.evaluate((value) => {
      const input = document.getElementById("chatInput") as HTMLTextAreaElement | null;
      const send = document.getElementById("chatSend") as HTMLButtonElement | null;
      if (!input || !send) return;
      input.value = value;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      send.click();
    }, "Trigger agent error");

    await expect.poll(() => agentCalls).toBe(1);
    await expect(page.locator("#inlineError")).toBeVisible();
    await expect(page.locator("#inlineErrorMessage")).toContainText(
      "Daemon chat request failed: Boom",
    );
    await expect(page.locator(".chatMessage.assistant.streaming")).toHaveCount(0);
    assertNoErrors(harness);
  } finally {
    await closeExtension(harness.context, harness.userDataDir);
  }
});

test("sidepanel hides inline error when message is empty", async ({
  browserName: _browserName,
}, testInfo) => {
  const harness = await launchExtension(getBrowserFromProject(testInfo.project.name));

  try {
    const page = await openExtensionPage(harness, "sidepanel.html", "#title", () => {
      (
        window as typeof globalThis & { __summarizeTestHooks?: Record<string, unknown> }
      ).__summarizeTestHooks = {};
    });
    await waitForPanelPort(page);
    await waitForSettingsHydratedHook(page);
    await page.evaluate(() => {
      const global = window as typeof globalThis & {
        __summarizePanelPort?: { disconnect?: () => void };
      };
      global.__summarizePanelPort?.disconnect?.();
      global.__summarizePanelPort = undefined;
    });

    const shown = await page.evaluate(
      (state) => {
        const hooks = (
          window as typeof globalThis & {
            __summarizeTestHooks?: {
              applyUiState?: (state: unknown) => void;
              showInlineError?: (message: string) => void;
              isInlineErrorVisible?: () => boolean;
              getInlineErrorMessage?: () => string;
            };
          }
        ).__summarizeTestHooks;
        hooks?.applyUiState?.(state);
        hooks?.showInlineError?.("Boom");
        return {
          visible: hooks?.isInlineErrorVisible?.() ?? false,
          message: hooks?.getInlineErrorMessage?.() ?? "",
        };
      },
      buildUiState({ daemon: { ok: false, authed: false } }),
    );
    expect(shown).toEqual({ visible: true, message: "Boom" });

    const hidden = await page.evaluate(() => {
      const hooks = (
        window as typeof globalThis & {
          __summarizeTestHooks?: {
            showInlineError?: (message: string) => void;
            isInlineErrorVisible?: () => boolean;
            getInlineErrorMessage?: () => string;
          };
        }
      ).__summarizeTestHooks;
      hooks?.showInlineError?.("   ");
      return {
        visible: hooks?.isInlineErrorVisible?.() ?? false,
        message: hooks?.getInlineErrorMessage?.() ?? "",
      };
    });

    expect(hidden).toEqual({ visible: false, message: "" });
    assertNoErrors(harness);
  } finally {
    await closeExtension(harness.context, harness.userDataDir);
  }
});

test("sidepanel shows daemon upgrade hint when /v1/agent is missing", async ({
  browserName: _browserName,
}, testInfo) => {
  const harness = await launchExtension(getBrowserFromProject(testInfo.project.name));

  try {
    await mockDaemonSummarize(harness);
    await seedSettings(harness, {
      token: "test-token",
      summaryRuntime: "daemon",
      autoSummarize: false,
      chatEnabled: true,
    });
    const contentPage = await harness.context.newPage();
    await contentPage.goto("https://example.com", { waitUntil: "domcontentloaded" });
    await contentPage.evaluate(() => {
      document.body.innerHTML = `<article><p>${"Agent 404 test. ".repeat(12)}</p></article>`;
    });
    await maybeBringToFront(contentPage);
    await activateTabByUrl(harness, "https://example.com");
    await waitForActiveTabUrl(harness, "https://example.com");
    await injectContentScript(harness, "content-scripts/extract.js", "https://example.com");
    await waitForExtractReady(harness, "https://example.com");

    let agentCalls = 0;
    await harness.context.route("http://127.0.0.1:8787/v1/agent", async (route) => {
      agentCalls += 1;
      await route.fulfill({
        status: 404,
        headers: { "content-type": "text/plain" },
        body: "Not Found",
      });
    });

    const page = await openExtensionPage(harness, "sidepanel.html", "#title");
    await waitForPanelPort(page);
    await waitForSettingsHydratedHook(page);
    await maybeBringToFront(contentPage);
    await activateTabByUrl(harness, "https://example.com");
    await waitForActiveTabUrl(harness, "https://example.com");
    const activeTabId = await getActiveTabId(harness);
    await sendBgMessage(harness, {
      type: "ui:state",
      state: buildUiState({
        tab: { id: activeTabId, url: "https://example.com", title: "Example" },
        settings: {
          chatEnabled: true,
          summaryRuntime: "daemon",
          tokenPresent: true,
        },
      }),
    });

    await expect(page.locator("#chatSend")).toBeEnabled();
    await page.locator("#chatInput").fill("Trigger agent 404");
    await page.locator("#chatSend").click();

    await expect.poll(() => agentCalls).toBe(1);
    await expect(page.locator("#inlineError")).toBeVisible();
    await expect(page.locator("#inlineErrorMessage")).toContainText(
      "Daemon does not support /v1/agent",
    );
    assertNoErrors(harness);
  } finally {
    await closeExtension(harness.context, harness.userDataDir);
  }
});

test("sidepanel shows automation notice when permission event fires", async ({
  browserName: _browserName,
}, testInfo) => {
  const harness = await launchExtension(getBrowserFromProject(testInfo.project.name));

  try {
    const page = await openExtensionPage(harness, "sidepanel.html", "#title");
    await waitForPanelPort(page);
    await waitForSettingsHydratedHook(page);
    await page.evaluate(() => {
      const global = window as typeof globalThis & {
        __summarizePanelPort?: { disconnect?: () => void };
      };
      global.__summarizePanelPort?.disconnect?.();
      global.__summarizePanelPort = undefined;
    });
    const notice = await page.evaluate(() => {
      window.dispatchEvent(
        new CustomEvent("summarize:automation-permissions", {
          detail: {
            title: "User Scripts required",
            message: "Enable User Scripts to use automation.",
            ctaLabel: "Open extension details",
          },
        }),
      );
      const noticeEl = document.getElementById("automationNotice");
      return {
        visible: !noticeEl?.classList.contains("hidden"),
        message: document.getElementById("automationNoticeMessage")?.textContent ?? "",
      };
    });

    expect(notice.visible).toBe(true);
    expect(notice.message).toContain("Enable User Scripts");
    assertNoErrors(harness);
  } finally {
    await closeExtension(harness.context, harness.userDataDir);
  }
});
