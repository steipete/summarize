import { expect } from "@playwright/test";
import { test } from "./helpers/extension-fixtures";
import {
  activateTabByUrl,
  buildUiState,
  getActiveTabId,
  openExtensionPage,
  seedSettings,
  sendBgMessage,
  sendPanelMessage,
  waitForActiveTabUrl,
  waitForPanelPort,
} from "./helpers/extension-harness";
import {
  getPanelModel,
  getPanelSummaryMarkdown,
  waitForSettingsHydratedHook,
} from "./helpers/panel-hooks";

test("Bilibili summaries use session captions for the selected part without a daemon", async ({
  harness,
}) => {
  const url = "https://www.bilibili.com/video/BV1ipnr6cExW/?p=2";
  const metadataRequests: Array<{ cid: string | null; hasSession: boolean }> = [];
  const headers = {
    "content-type": "application/json",
    "access-control-allow-origin": "https://www.bilibili.com",
    "access-control-allow-credentials": "true",
  };
  await harness.context.addCookies([
    {
      name: "caption_fixture",
      value: "present",
      domain: ".bilibili.com",
      path: "/",
      secure: true,
      sameSite: "None",
    },
  ]);
  await harness.context.route("https://www.bilibili.com/**", async (route) => {
    await route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><title>Bilibili caption fixture</title><article>Page description is not a transcript.</article><video></video>",
    });
  });
  await harness.context.route("https://api.bilibili.com/**", async (route) => {
    const requestUrl = new URL(route.request().url());
    const hasSession =
      (await route.request().allHeaders()).cookie?.includes("caption_fixture=present") ?? false;
    if (requestUrl.pathname === "/x/web-interface/view") {
      await route.fulfill({
        headers,
        body: JSON.stringify({
          code: 0,
          data: {
            bvid: "BV1ipnr6cExW",
            pages: [
              { page: 1, cid: 1 },
              { page: 2, cid: 42932375196, duration: 567 },
            ],
          },
        }),
      });
      return;
    }
    metadataRequests.push({ cid: requestUrl.searchParams.get("cid"), hasSession });
    await route.fulfill({
      headers,
      body: JSON.stringify({
        code: 0,
        data: {
          cid: 42932375196,
          subtitle: {
            subtitles: hasSession
              ? [
                  {
                    lan: "ai-en",
                    type: 1,
                    subtitle_url: "//aisubtitle.hdslb.com/bfs/ai_subtitle/prod/fixture",
                  },
                ]
              : [],
          },
        },
      }),
    });
  });
  await harness.context.route("https://aisubtitle.hdslb.com/**", async (route) => {
    await route.fulfill({
      headers,
      body: JSON.stringify({
        body: [
          { from: 1.16, to: 2.96, content: "Second part caption evidence." },
          { from: 562, to: 562.8, content: "Final caption evidence." },
        ],
      }),
    });
  });
  await seedSettings(harness, {
    token: "",
    model: "browser/gemini-nano",
    autoSummarize: false,
    slidesEnabled: false,
  });
  const content = await harness.context.newPage();
  await content.goto(url, { waitUntil: "domcontentloaded" });
  const panel = await openExtensionPage(harness, "sidepanel.html", "#title", () => {
    Object.defineProperty(globalThis, "Summarizer", {
      configurable: true,
      value: {
        availability: async () => "available",
        create: async () => ({
          inputQuota: 10_000,
          measureInputUsage: async (input: string) => input.length,
          summarize: async (input: string) =>
            input.includes("Second part caption evidence.") &&
            input.includes("Final caption evidence.") &&
            !input.includes("Page description")
              ? "* Caption summary from the second part"
              : "* Wrong summary input",
        }),
      },
    });
  });
  await waitForPanelPort(panel);
  await waitForSettingsHydratedHook(panel);
  await activateTabByUrl(harness, url);
  await waitForActiveTabUrl(harness, url);
  const tabId = await getActiveTabId(harness);
  await sendBgMessage(harness, {
    type: "ui:state",
    state: buildUiState({
      tab: { id: tabId, url, title: "Bilibili caption fixture" },
      media: { hasVideo: true, hasAudio: true, hasCaptions: false },
      settings: { autoSummarize: false, slidesEnabled: false, tokenPresent: false },
    }),
  });
  await sendPanelMessage(panel, { type: "panel:summarize", refresh: true });
  await expect.poll(() => getPanelModel(panel)).toBe("Gemini Nano");
  await expect
    .poll(() => getPanelSummaryMarkdown(panel))
    .toContain("Caption summary from the second part");
  await expect.poll(() => getPanelSummaryMarkdown(panel)).toContain("9:22");
  expect(metadataRequests).toEqual([{ cid: "42932375196", hasSession: true }]);
});
