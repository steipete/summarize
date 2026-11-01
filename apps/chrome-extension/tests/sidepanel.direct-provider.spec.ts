import { expect } from "@playwright/test";
import { test } from "./helpers/extension-fixtures";
import {
  activateTabByUrl,
  injectContentScript,
  openExtensionPage,
  seedSettings,
  sendPanelMessage,
  waitForActiveTabUrl,
  waitForExtractReady,
} from "./helpers/extension-harness";
import { getPanelSummaryMarkdown, waitForChatEnabled } from "./helpers/panel-hooks";

function openAiStream(text: string) {
  return [
    `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}`,
    "",
    "data: [DONE]",
    "",
  ].join("\n");
}

test("sidepanel summarizes and chats through a local direct provider without daemon", async ({
  harness,
}) => {
  await seedSettings(harness, {
    summaryRuntime: "direct",
    slideRuntime: "browser",
    provider: "openai",
    providerApiKeys: { openai: "test-key" },
    providerBaseUrls: { openai: "http://127.0.0.1:11434/v1" },
    model: "openai/test-model",
    autoSummarize: false,
    chatEnabled: true,
    automationEnabled: true,
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
  await harness.context.route("http://127.0.0.1:11434/v1/chat/completions", async (route) => {
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
  expect(JSON.stringify(requestBodies[0]?.messages)).toContain("Browser-local extraction content");

  await panel.locator("#chatInput").fill("What backend answered?");
  await panel.locator("#chatSend").click();
  await expect(panel.locator("#chatMessages")).toContainText("Direct chat reply");
  await expect.poll(() => requestCount).toBe(2);

  const advertisedTools = requestBodies.flatMap((body) => {
    if (!Array.isArray(body.tools)) return [];
    return body.tools
      .map((tool) => (tool as { function?: { name?: string } }).function?.name)
      .filter((name): name is string => Boolean(name));
  });
  const debuggerEnabled = await panel.evaluate(() =>
    chrome.runtime.getManifest().permissions?.includes("debugger"),
  );
  expect(advertisedTools).toContain("navigate");
  expect(advertisedTools.includes("debugger")).toBe(debuggerEnabled);
});

test("first article chat includes content beyond the media preview without a summary", async ({
  harness,
}) => {
  const url = "https://example.com/first-article-chat";
  const tail = "ARTICLE_END_CODE_7249";
  const article = `${"The lunar research program includes several detailed scientific experiments. ".repeat(100)} The archive code is ${tail}.`;
  await seedSettings(harness, {
    summaryRuntime: "direct",
    slideRuntime: "browser",
    provider: "openai",
    providerApiKeys: { openai: "test-key" },
    providerBaseUrls: { openai: "http://127.0.0.1:11434/v1" },
    model: "openai/test-model",
    autoSummarize: false,
    chatEnabled: true,
    automationEnabled: false,
    slidesEnabled: false,
    token: "",
  });
  await harness.context.route(url, (route) =>
    route.fulfill({
      status: 200,
      contentType: "text/html",
      body: `<html><head><title>Lunar research</title></head><body><article><h1>Lunar research</h1><p>${article}</p></article></body></html>`,
    }),
  );
  const content = await harness.context.newPage();
  await content.goto(url, { waitUntil: "domcontentloaded" });
  await activateTabByUrl(harness, url);
  await waitForActiveTabUrl(harness, url);
  await injectContentScript(harness, "content-scripts/extract.js", url);
  await waitForExtractReady(harness, url);

  const requests: Array<Record<string, unknown>> = [];
  await harness.context.route("http://127.0.0.1:11434/v1/chat/completions", async (route) => {
    requests.push(route.request().postDataJSON());
    await route.fulfill({
      status: 200,
      headers: { "content-type": "text/event-stream" },
      body: openAiStream("Article context received."),
    });
  });
  const panel = await openExtensionPage(harness, "sidepanel.html", "#title");
  await waitForChatEnabled(panel, true);
  await panel.evaluate(() => {
    const state = window as typeof globalThis & {
      __summarizePanelPort?: chrome.runtime.Port;
      __mediaHintReady?: boolean;
    };
    state.__summarizePanelPort?.onMessage.addListener((message: unknown) => {
      if (
        !message ||
        typeof message !== "object" ||
        !("type" in message) ||
        message.type !== "ui:state" ||
        !("state" in message)
      )
        return;
      const ui = message.state;
      if (ui && typeof ui === "object" && "media" in ui && ui.media !== null)
        state.__mediaHintReady = true;
    });
  });
  await sendPanelMessage(panel, { type: "panel:ping" });
  await panel.waitForFunction(
    () => (window as typeof globalThis & { __mediaHintReady?: boolean }).__mediaHintReady === true,
  );
  expect(await getPanelSummaryMarkdown(panel)).toBe("");
  expect(requests).toHaveLength(0);
  await panel.locator("#chatInput").fill("What is the archive code at the end of the article?");
  await panel.locator("#chatSend").click();
  await expect(panel.locator("#chatMessages")).toContainText("Article context received.");
  await expect.poll(() => requests.length).toBe(1);
  expect(JSON.stringify(requests[0]?.messages)).toContain(tail);
});
