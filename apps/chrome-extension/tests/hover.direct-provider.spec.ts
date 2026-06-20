import { expect, test } from "@playwright/test";
import {
  activateTabByUrl,
  assertNoErrors,
  closeExtension,
  getBrowserFromProject,
  launchExtension,
  maybeBringToFront,
  seedSettings,
  trackErrors,
  waitForActiveTabUrl,
} from "./helpers/extension-harness";
import { allowFirefoxExtensionTests } from "./helpers/extension-test-config";

function openAiStream(text: string) {
  return [
    `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}`,
    "",
    "data: [DONE]",
    "",
  ].join("\n");
}

test.skip(
  ({ browserName }) => browserName === "firefox" && !allowFirefoxExtensionTests,
  "Firefox extension tests are blocked by Playwright limitations. Set ALLOW_FIREFOX_EXTENSION_TESTS=1 to run.",
);

test("hover tooltip summarizes through a direct provider without a daemon token", async ({
  browserName: _browserName,
}, testInfo) => {
  const harness = await launchExtension(getBrowserFromProject(testInfo.project.name));

  try {
    await seedSettings(harness, {
      token: "",
      hoverSummaries: true,
      summaryRuntime: "direct",
      provider: "openai",
      providerApiKeys: { openai: "test-key" },
      providerBaseUrls: { openai: "https://api.openai.test/v1" },
      model: "openai/test-model",
      maxChars: 60_000,
    });

    let articleFetches = 0;
    await harness.context.route("https://example.com/hover-proof", async (route) => {
      await route.fulfill({
        status: 200,
        headers: { "content-type": "text/html" },
        body: `
          <main>
            <h1>Hover proof page</h1>
            <a id="target" href="https://example.com/hover-proof-target">Summarize target</a>
          </main>
        `,
      });
    });
    await harness.context.route("https://example.com/hover-proof-target", async (route) => {
      articleFetches += 1;
      await route.fulfill({
        status: 200,
        headers: { "content-type": "text/html" },
        body: `<article><h1>Target article</h1><p>${"Direct provider hover content. ".repeat(
          80,
        )}</p></article>`,
      });
    });

    let providerCalls = 0;
    let daemonSummarizeCalls = 0;
    const requestBodies: Array<Record<string, unknown>> = [];
    await harness.context.route("https://api.openai.test/v1/chat/completions", async (route) => {
      providerCalls += 1;
      requestBodies.push(route.request().postDataJSON() as Record<string, unknown>);
      await route.fulfill({
        status: 200,
        headers: { "content-type": "text/event-stream" },
        body: openAiStream("Direct hover proof without daemon token."),
      });
    });
    await harness.context.route(
      /http:\/\/127\.0\.0\.1:8787\/v1\/summarize(?:\/.*)?$/,
      async (route) => {
        daemonSummarizeCalls += 1;
        await route.fulfill({
          status: 500,
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ ok: false, error: "daemon should not be called" }),
        });
      },
    );

    const page = await harness.context.newPage();
    trackErrors(page, harness.pageErrors, harness.consoleErrors);
    await page.goto("https://example.com/hover-proof", { waitUntil: "domcontentloaded" });
    await maybeBringToFront(page);
    await activateTabByUrl(harness, "https://example.com/hover-proof");
    await waitForActiveTabUrl(harness, "https://example.com/hover-proof");

    await page.locator("#target").hover();

    const tooltip = page.locator('#__summarize_hover_tooltip__[data-visible="true"] .summary');
    await expect(tooltip).toContainText("Direct hover proof without daemon token.");
    await expect.poll(() => articleFetches).toBe(1);
    await expect.poll(() => providerCalls).toBe(1);
    await expect.poll(() => daemonSummarizeCalls).toBe(0);
    expect(requestBodies[0]?.model).toBe("test-model");
    expect(JSON.stringify(requestBodies[0]?.messages)).toContain("Direct provider hover content");

    const screenshotPath = process.env.HOVER_PROOF_SCREENSHOT;
    if (screenshotPath) {
      await page.screenshot({ path: screenshotPath, fullPage: true });
    }

    assertNoErrors(harness);
  } finally {
    await closeExtension(harness.context, harness.userDataDir);
  }
});
