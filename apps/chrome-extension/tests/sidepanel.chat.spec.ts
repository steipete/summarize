import { expect, test } from "@playwright/test";
import { getSummarizeCalls, mockDaemonSummarize } from "./helpers/daemon-fixtures";
import {
  activateTabByUrl,
  assertNoErrors,
  buildAgentStream,
  buildUiState,
  closeExtension,
  getActiveTabId,
  getBackground,
  getBrowserFromProject,
  injectContentScript,
  launchExtension,
  maybeBringToFront,
  openExtensionPage,
  seedSettings,
  sendBgMessage,
  sendPanelMessage,
  trackErrors,
  waitForActiveTabUrl,
  waitForExtractReady,
  waitForPanelPort,
} from "./helpers/extension-harness";
import { allowFirefoxExtensionTests } from "./helpers/extension-test-config";

test.skip(
  ({ browserName }) => browserName === "firefox" && !allowFirefoxExtensionTests,
  "Firefox extension tests are blocked by Playwright limitations. Set ALLOW_FIREFOX_EXTENSION_TESTS=1 to run.",
);

test("sidepanel chat queue sends next message after stream completes", async ({
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
      document.body.innerHTML = `<article><p>${"Hello ".repeat(40)}</p><p>More text for chat.</p></article>`;
    });
    await maybeBringToFront(contentPage);
    await activateTabByUrl(harness, "https://example.com");
    await waitForActiveTabUrl(harness, "https://example.com");
    await injectContentScript(harness, "content-scripts/extract.js", "https://example.com");
    await waitForExtractReady(harness, "https://example.com");

    const page = await openExtensionPage(harness, "sidepanel.html", "#title");

    let agentRequestCount = 0;
    let releaseFirst: (() => void) | null = null;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    await harness.context.route("http://127.0.0.1:8787/v1/agent", async (route) => {
      agentRequestCount += 1;
      if (agentRequestCount === 1) await firstGate;
      const body = buildAgentStream(`Reply ${agentRequestCount}`);
      await route.fulfill({
        status: 200,
        headers: { "content-type": "text/event-stream" },
        body,
      });
    });

    const sendChat = async (text: string) => {
      await page.evaluate((value) => {
        const input = document.getElementById("chatInput") as HTMLTextAreaElement | null;
        const send = document.getElementById("chatSend") as HTMLButtonElement | null;
        if (!input || !send) return;
        input.value = value;
        input.dispatchEvent(new Event("input", { bubbles: true }));
        send.click();
      }, text);
    };

    await maybeBringToFront(contentPage);
    await activateTabByUrl(harness, "https://example.com");
    await waitForActiveTabUrl(harness, "https://example.com");
    await sendChat("First question");
    await expect.poll(() => agentRequestCount).toBe(1);
    await sendChat("Second question");
    await expect.poll(() => agentRequestCount, { timeout: 1_000 }).toBe(1);

    releaseFirst?.();

    await expect.poll(() => agentRequestCount).toBe(2);
    await expect(page.locator("#chatMessages")).toContainText("Second question");

    assertNoErrors(harness);
  } finally {
    await closeExtension(harness.context, harness.userDataDir);
  }
});

test("sidepanel chat sends mixed OCR and transcript slide text to the bot", async ({
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
      slidesOcrEnabled: true,
      length: "xl",
    });
    const contentPage = await harness.context.newPage();
    await contentPage.goto("https://example.com/slides", { waitUntil: "domcontentloaded" });
    await contentPage.evaluate(() => {
      document.body.innerHTML = `<article><p>${"Deck context ".repeat(40)}</p></article>`;
    });
    await maybeBringToFront(contentPage);
    await activateTabByUrl(harness, "https://example.com/slides");
    await waitForActiveTabUrl(harness, "https://example.com/slides");
    await injectContentScript(harness, "content-scripts/extract.js", "https://example.com/slides");
    await waitForExtractReady(harness, "https://example.com/slides");
    const activeTabId = await getActiveTabId(harness);

    const page = await openExtensionPage(harness, "sidepanel.html", "#title");
    const transcriptTimedText = [
      "[0:00] First slide transcript context.",
      "[0:30] More first slide detail.",
      "[0:42] Second slide transcript should be replaced by OCR.",
      "[1:28] Lead-in near the third slide.",
      "[1:32] Third slide transcript context.",
    ].join("\n");
    await sendPanelMessage(page, {
      type: "panel:cache",
      cache: {
        tabId: activeTabId,
        url: "https://example.com/slides",
        title: "Slides",
        runId: "summary-run",
        slidesRunId: "slides-run",
        summaryMarkdown: "Summary text.",
        summaryFromCache: false,
        slidesSummaryMarkdown: null,
        slidesSummaryComplete: null,
        slidesSummaryModel: null,
        lastMeta: { inputSummary: null, model: "test", modelLabel: "Test" },
        transcriptTimedText,
        slides: {
          sourceUrl: "https://example.com/slides",
          sourceId: "local-slides",
          sourceKind: "browser-capture",
          ocrAvailable: false,
          transcriptTimedText,
          slides: [
            { index: 1, timestamp: 1, imageUrl: "", ocrText: null, ocrConfidence: null },
            {
              index: 2,
              timestamp: 40,
              imageUrl: "",
              ocrText: "Second slide visual OCR.",
              ocrConfidence: null,
            },
            { index: 3, timestamp: 90, imageUrl: "", ocrText: null, ocrConfidence: null },
          ],
        },
      },
    });

    let agentPageContent = "";
    await harness.context.route("http://127.0.0.1:8787/v1/agent", async (route) => {
      const body = route.request().postDataJSON() as { pageContent?: string };
      agentPageContent = body.pageContent ?? "";
      await route.fulfill({
        status: 200,
        headers: { "content-type": "text/event-stream" },
        body: buildAgentStream("Slide-aware reply"),
      });
    });

    await page.locator("#chatInput").fill("What is on each slide?");
    await page.locator("#chatSend").click();

    await expect.poll(() => agentPageContent).toContain("Slide timeline:");
    expect(agentPageContent).toContain("Slide 1 @ 0:01");
    expect(agentPageContent).toContain("First slide transcript context.");
    expect(agentPageContent).toContain("Slide 2 @ 0:40");
    expect(agentPageContent).toContain("Second slide visual OCR.");
    expect(agentPageContent).toContain("Slide 3 @ 1:30");
    expect(agentPageContent).toContain("Third slide transcript context.");

    assertNoErrors(harness);
  } finally {
    await closeExtension(harness.context, harness.userDataDir);
  }
});

test("sidepanel chat queue drains messages after stream completes", async ({
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
      document.body.innerHTML = `<article><p>${"Hello ".repeat(40)}</p><p>More text for chat.</p></article>`;
    });
    await maybeBringToFront(contentPage);
    await activateTabByUrl(harness, "https://example.com");
    await waitForActiveTabUrl(harness, "https://example.com");
    await injectContentScript(harness, "content-scripts/extract.js", "https://example.com");
    await waitForExtractReady(harness, "https://example.com");

    const page = await openExtensionPage(harness, "sidepanel.html", "#title");

    let agentRequestCount = 0;
    let releaseFirst: (() => void) | null = null;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    await harness.context.route("http://127.0.0.1:8787/v1/agent", async (route) => {
      agentRequestCount += 1;
      if (agentRequestCount === 1) await firstGate;
      const body = buildAgentStream(`Reply ${agentRequestCount}`);
      await route.fulfill({
        status: 200,
        headers: { "content-type": "text/event-stream" },
        body,
      });
    });

    const sendChat = async (text: string) => {
      await page.evaluate((value) => {
        const input = document.getElementById("chatInput") as HTMLTextAreaElement | null;
        const send = document.getElementById("chatSend") as HTMLButtonElement | null;
        if (!input || !send) return;
        input.value = value;
        input.dispatchEvent(new Event("input", { bubbles: true }));
        send.click();
      }, text);
    };

    await maybeBringToFront(contentPage);
    await activateTabByUrl(harness, "https://example.com");
    await waitForActiveTabUrl(harness, "https://example.com");
    await sendChat("First question");
    await expect.poll(() => agentRequestCount).toBe(1);

    const enqueueChat = async (text: string) => {
      await page.evaluate((value) => {
        const input = document.getElementById("chatInput") as HTMLTextAreaElement | null;
        if (!input) return;
        input.value = value;
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: "Enter",
            code: "Enter",
            bubbles: true,
            cancelable: true,
          }),
        );
      }, text);
    };

    await enqueueChat("Second question");
    await enqueueChat("Third question");

    releaseFirst?.();

    await expect.poll(() => agentRequestCount).toBeGreaterThanOrEqual(3);
    await expect(page.locator("#chatMessages")).toContainText("Second question");
    await expect(page.locator("#chatMessages")).toContainText("Third question");

    assertNoErrors(harness);
  } finally {
    await closeExtension(harness.context, harness.userDataDir);
  }
});

test("sidepanel clears chat on user navigation", async ({
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
      document.body.innerHTML = `<article><p>Chat nav test.</p></article>`;
    });
    await maybeBringToFront(contentPage);
    await activateTabByUrl(harness, "https://example.com");
    await waitForActiveTabUrl(harness, "https://example.com");
    await injectContentScript(harness, "content-scripts/extract.js", "https://example.com");

    await harness.context.route("http://127.0.0.1:8787/v1/agent", async (route) => {
      const body = buildAgentStream("Ack");
      await route.fulfill({
        status: 200,
        headers: { "content-type": "text/event-stream" },
        body,
      });
    });

    const page = await openExtensionPage(harness, "sidepanel.html", "#title");
    await sendBgMessage(harness, {
      type: "ui:state",
      state: buildUiState({
        tab: { id: 1, url: "https://example.com", title: "Example" },
        settings: {
          chatEnabled: true,
          summaryRuntime: "daemon",
          tokenPresent: true,
        },
      }),
    });

    await page.evaluate((value) => {
      const input = document.getElementById("chatInput") as HTMLTextAreaElement | null;
      const send = document.getElementById("chatSend") as HTMLButtonElement | null;
      if (!input || !send) return;
      input.value = value;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      send.click();
    }, "Hello");

    await expect(page.locator("#chatMessages")).toContainText("Hello");

    await sendBgMessage(harness, {
      type: "ui:state",
      state: buildUiState({
        tab: { id: 1, url: "https://example.com/next", title: "Next" },
        settings: {
          chatEnabled: true,
          summaryRuntime: "daemon",
          tokenPresent: true,
        },
      }),
    });

    await expect(page.locator(".chatMessage")).toHaveCount(0);
    await expect(page.locator("#chatMessages")).not.toContainText("Tool result: navigation");
    assertNoErrors(harness);
  } finally {
    await closeExtension(harness.context, harness.userDataDir);
  }
});

test("auto summarize reruns after panel reopen", async ({
  browserName: _browserName,
}, testInfo) => {
  const harness = await launchExtension(getBrowserFromProject(testInfo.project.name));

  try {
    await mockDaemonSummarize(harness);

    const sseBody = [
      "event: chunk",
      'data: {"text":"First chunk"}',
      "",
      "event: done",
      "data: {}",
      "",
    ].join("\n");
    await harness.context.route(
      /http:\/\/127\.0\.0\.1:8787\/v1\/summarize\/[^/]+\/events/,
      async (route) => {
        await route.fulfill({
          status: 200,
          headers: { "content-type": "text/event-stream" },
          body: sseBody,
        });
      },
    );

    await seedSettings(harness, {
      token: "test-token",
      autoSummarize: true,
      slideRuntime: "daemon",
    });

    const contentPage = await harness.context.newPage();
    await contentPage.goto("https://example.com", { waitUntil: "domcontentloaded" });
    const activeUrl = contentPage.url();
    await maybeBringToFront(contentPage);
    await activateTabByUrl(harness, "https://example.com");
    await waitForActiveTabUrl(harness, "https://example.com");

    const panel = await openExtensionPage(harness, "sidepanel.html", "#title");
    await maybeBringToFront(contentPage);
    await activateTabByUrl(harness, "https://example.com");
    await waitForActiveTabUrl(harness, "https://example.com");
    await mockDaemonSummarize(harness);
    await sendPanelMessage(panel, { type: "panel:ready" });
    await expect.poll(async () => await getSummarizeCalls(harness)).toBeGreaterThanOrEqual(1);
    await sendPanelMessage(panel, { type: "panel:rememberUrl", url: activeUrl });

    const callsBeforeClose = await getSummarizeCalls(harness);
    await sendPanelMessage(panel, { type: "panel:closed" });
    await maybeBringToFront(contentPage);
    await activateTabByUrl(harness, "https://example.com");
    await waitForActiveTabUrl(harness, "https://example.com");
    await mockDaemonSummarize(harness);
    await sendPanelMessage(panel, { type: "panel:ready" });
    await expect
      .poll(async () => await getSummarizeCalls(harness))
      .toBeGreaterThan(callsBeforeClose);
    assertNoErrors(harness);
  } finally {
    await closeExtension(harness.context, harness.userDataDir);
  }
});

test("sidepanel updates title while streaming on same URL", async ({
  browserName: _browserName,
}, testInfo) => {
  const harness = await launchExtension(getBrowserFromProject(testInfo.project.name));

  try {
    await mockDaemonSummarize(harness);
    const sseBody = [
      "event: chunk",
      'data: {"text":"Hello"}',
      "",
      "event: done",
      "data: {}",
      "",
    ].join("\n");
    await harness.context.route(
      /http:\/\/127\.0\.0\.1:8787\/v1\/summarize\/[^/]+\/events/,
      async (route) => {
        await route.fulfill({
          status: 200,
          headers: { "content-type": "text/event-stream" },
          body: sseBody,
        });
      },
    );

    await seedSettings(harness, { token: "test-token", autoSummarize: false });
    const page = await openExtensionPage(harness, "sidepanel.html", "#title");
    await waitForPanelPort(page);

    await sendBgMessage(harness, {
      type: "ui:state",
      state: buildUiState({
        tab: { id: 1, url: "https://example.com/watch?v=1", title: "Old Title" },
        settings: { autoSummarize: false, tokenPresent: true },
        status: "",
      }),
    });

    await sendBgMessage(harness, {
      type: "run:start",
      run: {
        id: "run-1",
        url: "https://example.com/watch?v=1",
        title: "Old Title",
        model: "auto",
        reason: "manual",
      },
    });
    await expect(page.locator("#title")).toHaveText("Old Title");

    await sendBgMessage(harness, {
      type: "ui:state",
      state: buildUiState({
        tab: { url: "https://example.com/watch?v=1", title: "New Title" },
        settings: { autoSummarize: false, tokenPresent: true },
        status: "",
      }),
    });
    await expect(page.locator("#title")).toHaveText("New Title");

    await new Promise((resolve) => setTimeout(resolve, 200));
    assertNoErrors(harness);
  } finally {
    await closeExtension(harness.context, harness.userDataDir);
  }
});

test("hover tooltip proxies daemon calls via background (no page-origin localhost fetch)", async ({
  browserName: _browserName,
}, testInfo) => {
  test.setTimeout(30_000);
  const harness = await launchExtension(getBrowserFromProject(testInfo.project.name));

  try {
    await seedSettings(harness, {
      token: "test-token",
      hoverSummaries: true,
      summaryRuntime: "daemon",
    });
    await mockDaemonSummarize(harness);

    let eventsCalls = 0;

    const sseBody = [
      "event: chunk",
      'data: {"text":"Hello hover"}',
      "",
      "event: done",
      "data: {}",
      "",
    ].join("\n");
    await harness.context.route(
      /http:\/\/127\.0\.0\.1:8787\/v1\/summarize\/[^/]+\/events/,
      async (route) => {
        eventsCalls += 1;
        await route.fulfill({
          status: 200,
          headers: { "content-type": "text/event-stream" },
          body: sseBody,
        });
      },
    );

    const page = await harness.context.newPage();
    trackErrors(page, harness.pageErrors, harness.consoleErrors);
    await page.goto("https://example.com", { waitUntil: "domcontentloaded" });
    await maybeBringToFront(page);
    await activateTabByUrl(harness, "https://example.com");
    await waitForActiveTabUrl(harness, "https://example.com");

    const background = await getBackground(harness);
    const hoverResponse = await background.evaluate(async () => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id) return { ok: false, error: "missing tab" };
      const [result] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        world: "ISOLATED",
        func: async () => {
          return chrome.runtime.sendMessage({
            type: "hover:summarize",
            requestId: "hover-1",
            url: "https://example.com/next",
            title: "Next",
            token: "test-token",
          });
        },
      });
      return result?.result ?? { ok: false, error: "no response" };
    });
    expect(hoverResponse).toEqual(expect.objectContaining({ ok: true }));

    await expect.poll(() => getSummarizeCalls(harness)).toBeGreaterThan(0);
    await expect.poll(() => eventsCalls).toBeGreaterThan(0);

    assertNoErrors(harness);
  } finally {
    await closeExtension(harness.context, harness.userDataDir);
  }
});

test("content script extracts visible duration metadata", async ({
  browserName: _browserName,
}, testInfo) => {
  const harness = await launchExtension(getBrowserFromProject(testInfo.project.name));

  try {
    const page = await harness.context.newPage();
    await page.goto("https://example.com", { waitUntil: "domcontentloaded" });
    await page.setContent(`
      <html>
        <head>
          <meta itemprop="duration" content="PT5M21S" />
        </head>
        <body>
          <video id="hero" controls>
            <source src="movie.mp4" type="video/mp4" />
          </video>
          <div class="ytp-time-duration">5:21</div>
        </body>
      </html>
    `);

    await maybeBringToFront(page);
    await activateTabByUrl(harness, "https://example.com");
    await waitForActiveTabUrl(harness, "https://example.com");
    await injectContentScript(harness, "content-scripts/extract.js", "https://example.com");
    const background = await getBackground(harness);
    const result = await background.evaluate(async () => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id) return null;
      return await chrome.tabs.sendMessage(tab.id, { type: "extract", maxChars: 1200 });
    });

    expect(result).toEqual(expect.objectContaining({ mediaDurationSeconds: 321 }));
    assertNoErrors(harness);
  } finally {
    await closeExtension(harness.context, harness.userDataDir);
  }
});
