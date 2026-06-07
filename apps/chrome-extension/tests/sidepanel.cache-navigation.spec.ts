import { expect, test } from "@playwright/test";
import {
  getSummarizeBodies,
  getSummarizeCallTimes,
  getSummarizeCalls,
  mockDaemonSummarize,
} from "./helpers/daemon-fixtures";
import {
  activateTabByUrl,
  assertNoErrors,
  closeExtension,
  getBrowserFromProject,
  injectContentScript,
  launchExtension,
  maybeBringToFront,
  openExtensionPage,
  seedSettings,
  sendBgMessage,
  sendPanelMessage,
  waitForActiveTabUrl,
  waitForPanelPort,
} from "./helpers/extension-harness";

test("sidepanel auto summarizes quickly when switching YouTube tabs", async ({
  browserName: _browserName,
}, testInfo) => {
  const harness = await launchExtension(getBrowserFromProject(testInfo.project.name));

  try {
    await mockDaemonSummarize(harness);
    await seedSettings(harness, {
      token: "test-token",
      autoSummarize: true,
      slidesEnabled: false,
      slideRuntime: "daemon",
    });
    await harness.context.route("https://www.youtube.com/**", async (route) => {
      await route.fulfill({
        status: 200,
        headers: { "content-type": "text/html" },
        body: "<html><body><article>YouTube placeholder</article></body></html>",
      });
    });

    const videoA = "https://www.youtube.com/watch?v=videoA12345";
    const videoB = "https://www.youtube.com/watch?v=videoB67890";

    const pageA = await harness.context.newPage();
    await pageA.goto(videoA, { waitUntil: "domcontentloaded" });
    const pageB = await harness.context.newPage();
    await pageB.goto(videoB, { waitUntil: "domcontentloaded" });

    await activateTabByUrl(harness, videoA);
    await waitForActiveTabUrl(harness, videoA);
    await injectContentScript(harness, "content-scripts/extract.js", videoA);
    await injectContentScript(harness, "content-scripts/extract.js", videoB);

    const sseBody = (text: string) =>
      ["event: chunk", `data: ${JSON.stringify({ text })}`, "", "event: done", "data: {}", ""].join(
        "\n",
      );
    await harness.context.route("http://127.0.0.1:8787/v1/summarize/**/events", async (route) => {
      const url = route.request().url();
      const match = url.match(/summarize\/([^/]+)\/events/);
      const runId = match ? (match[1] ?? "") : "";
      const runIndex = Number.parseInt(runId.replace("run-", ""), 10);
      const summaryText = runIndex % 2 === 1 ? "Video A summary" : "Video B summary";
      await route.fulfill({
        status: 200,
        headers: { "content-type": "text/event-stream" },
        body: sseBody(summaryText),
      });
    });
    const panel = await openExtensionPage(harness, "sidepanel.html", "#title");
    await waitForPanelPort(panel);
    await maybeBringToFront(pageA);
    await activateTabByUrl(harness, videoA);
    await waitForActiveTabUrl(harness, videoA);
    await mockDaemonSummarize(harness);

    const maxPromptSummarizeDelayMs = 6_000;
    const waitForSummarizeCall = async (sinceCount: number, startedAt: number) => {
      await expect
        .poll(async () => await getSummarizeCalls(harness), { timeout: maxPromptSummarizeDelayMs })
        .toBeGreaterThan(sinceCount);
      const callTimes = await getSummarizeCallTimes(harness);
      const callTime = callTimes[sinceCount] ?? callTimes.at(-1) ?? Date.now();
      expect(callTime - startedAt).toBeLessThan(maxPromptSummarizeDelayMs);
    };

    const callsBeforeReady = await getSummarizeCalls(harness);
    const startA = Date.now();
    await sendPanelMessage(panel, { type: "panel:ready" });
    await waitForSummarizeCall(callsBeforeReady, startA);
    await expect
      .poll(async () => {
        const bodies = (await getSummarizeBodies(harness)) as Array<Record<string, unknown>>;
        return bodies.some((body) => body?.url === videoA);
      })
      .toBe(true);

    const callsBeforeB = await getSummarizeCalls(harness);
    const startB = Date.now();
    await activateTabByUrl(harness, videoB);
    await waitForActiveTabUrl(harness, videoB);
    await waitForSummarizeCall(callsBeforeB, startB);
    await expect
      .poll(async () => {
        const bodies = (await getSummarizeBodies(harness)) as Array<Record<string, unknown>>;
        return bodies.some((body) => body?.url === videoB);
      })
      .toBe(true);

    const callsBeforeReturn = await getSummarizeCalls(harness);
    const startA2 = Date.now();
    await activateTabByUrl(harness, videoA);
    await waitForActiveTabUrl(harness, videoA);

    const callsAfterReturn = await getSummarizeCalls(harness);
    if (callsAfterReturn > callsBeforeReturn) {
      const callTimes = await getSummarizeCallTimes(harness);
      const callTime = callTimes[callsAfterReturn - 1] ?? callTimes.at(-1) ?? Date.now();
      expect(callTime - startA2).toBeLessThan(maxPromptSummarizeDelayMs);
    }

    assertNoErrors(harness);
  } finally {
    await closeExtension(harness.context, harness.userDataDir);
  }
});
