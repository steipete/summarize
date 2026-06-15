import { expect, test } from "@playwright/test";
import {
  activateTabByUrl,
  assertNoErrors,
  closeExtension,
  getBrowserFromProject,
  injectContentScript,
  launchExtension,
  openExtensionPage,
  seedSettings,
  sendPanelMessage,
  waitForActiveTabUrl,
  waitForExtractReady,
} from "./helpers/extension-harness";
import { getPanelSummaryMarkdown } from "./helpers/panel-hooks";

function openAiStream(text: string) {
  return [
    `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}`,
    "",
    "data: [DONE]",
    "",
  ].join("\n");
}

test("sidepanel summarizes and chats through a direct provider without daemon", async ({
  browserName: _browserName,
}, testInfo) => {
  const harness = await launchExtension(getBrowserFromProject(testInfo.project.name));

  try {
    await seedSettings(harness, {
      summaryRuntime: "direct",
      slideRuntime: "browser",
      provider: "openai",
      providerApiKeys: { openai: "test-key" },
      providerBaseUrls: { openai: "https://api.openai.test/v1" },
      model: "openai/test-model",
      autoSummarize: false,
      chatEnabled: true,
      automationEnabled: false,
    });
    const contentPage = await harness.context.newPage();
    await contentPage.goto("https://example.com/direct-provider", {
      waitUntil: "domcontentloaded",
    });
    await contentPage.evaluate(() => {
      document.title = "Direct provider article";
      document.body.innerHTML = `<article><h1>Direct provider article</h1><p>${"Browser-local extraction content. ".repeat(
        50,
      )}</p></article>`;
    });
    await activateTabByUrl(harness, "https://example.com/direct-provider");
    await waitForActiveTabUrl(harness, "https://example.com/direct-provider");
    await injectContentScript(
      harness,
      "content-scripts/extract.js",
      "https://example.com/direct-provider",
    );
    await waitForExtractReady(harness, "https://example.com/direct-provider");

    let requestCount = 0;
    const requestBodies: Array<Record<string, unknown>> = [];
    await harness.context.route("https://api.openai.test/v1/chat/completions", async (route) => {
      requestCount += 1;
      requestBodies.push(route.request().postDataJSON() as Record<string, unknown>);
      await route.fulfill({
        status: 200,
        headers: { "content-type": "text/event-stream" },
        body: openAiStream(
          requestCount === 1 ? "## Direct summary\n\nNo daemon used." : "Direct chat reply.",
        ),
      });
    });

    const panel = await openExtensionPage(harness, "sidepanel.html", "#title");
    await sendPanelMessage(panel, { type: "panel:summarize", refresh: true });

    await expect.poll(() => getPanelSummaryMarkdown(panel)).toContain("No daemon used");
    expect(requestBodies[0]?.model).toBe("test-model");
    expect(JSON.stringify(requestBodies[0]?.messages)).toContain(
      "Browser-local extraction content",
    );

    await panel.locator("#chatInput").fill("What backend answered?");
    await panel.locator("#chatSend").click();
    await expect(panel.locator("#chatMessages")).toContainText("Direct chat reply");
    await expect.poll(() => requestCount).toBe(2);

    assertNoErrors(harness);
  } finally {
    await closeExtension(harness.context, harness.userDataDir);
  }
});
