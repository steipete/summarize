import { expect } from "@playwright/test";
import { buildSlidesPayload } from "./helpers/daemon-fixtures";
import { test } from "./helpers/extension-fixtures";
import {
  buildUiState,
  openExtensionPage,
  seedSettings,
  sendBgMessage,
  waitForPanelPort,
} from "./helpers/extension-harness";
import {
  getPanelSlideDescriptions,
  getPanelSlidesTimeline,
  getPanelSummaryMarkdown,
  waitForApplySlidesHook,
  waitForSettingsHydratedHook,
} from "./helpers/panel-hooks";

test("sidepanel resumes slides when returning to a tab", async ({ harness }) => {
  await seedSettings(harness, {
    token: "test-token",
    autoSummarize: false,
    slidesEnabled: true,
    slidesParallel: true,
    slidesOcrEnabled: true,
  });
  const page = await openExtensionPage(harness, "sidepanel.html", "#title");
  await waitForPanelPort(page);
  await waitForSettingsHydratedHook(page);

  const slidesPayload = {
    sourceUrl: "https://www.youtube.com/watch?v=abc123",
    sourceId: "alpha",
    sourceKind: "youtube",
    ocrAvailable: true,
    slides: [
      {
        index: 1,
        timestamp: 0,
        imageUrl: "http://127.0.0.1:8787/v1/slides/alpha/1?v=1",
        ocrText: "Alpha slide one.",
      },
    ],
  };
  await page.route("http://127.0.0.1:8787/v1/summarize/**/slides", async (route) => {
    await route.fulfill({
      status: 200,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ok: true, slides: slidesPayload }),
    });
  });

  const slidesStreamBody = [
    "event: slides",
    `data: ${JSON.stringify(slidesPayload)}`,
    "",
    "event: done",
    "data: {}",
    "",
  ].join("\n");
  await page.route("http://127.0.0.1:8787/v1/summarize/slides-a/slides/events", async (route) => {
    await route.fulfill({
      status: 200,
      headers: { "content-type": "text/event-stream" },
      body: slidesStreamBody,
    });
  });
  await page.route("http://127.0.0.1:8787/v1/summarize/slides-a/events", async (route) => {
    await route.fulfill({
      status: 200,
      headers: { "content-type": "text/event-stream" },
      body: ["event: done", "data: {}", ""].join("\n"),
    });
  });

  const placeholderPng = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO3kq0cAAAAASUVORK5CYII=",
    "base64",
  );
  await page.route("http://127.0.0.1:8787/v1/slides/**", async (route) => {
    await route.fulfill({
      status: 200,
      headers: {
        "content-type": "image/png",
        "x-summarize-slide-ready": "1",
      },
      body: placeholderPng,
    });
  });

  const tabAState = buildUiState({
    tab: { id: 1, url: "https://www.youtube.com/watch?v=abc123", title: "Alpha Video" },
    media: { hasVideo: true, hasAudio: true, hasCaptions: true },
    settings: {
      autoSummarize: false,
      slidesEnabled: true,
      slidesParallel: true,
      slidesOcrEnabled: true,
      tokenPresent: true,
    },
  });
  const tabBState = buildUiState({
    tab: { id: 2, url: "https://example.com", title: "Bravo Tab" },
    media: { hasVideo: false, hasAudio: false, hasCaptions: false },
    settings: {
      autoSummarize: false,
      slidesEnabled: true,
      slidesParallel: true,
      slidesOcrEnabled: true,
      tokenPresent: true,
    },
  });
  await sendBgMessage(harness, { type: "ui:state", state: tabAState });
  await sendBgMessage(harness, { type: "ui:state", state: tabBState });
  await expect.poll(async () => (await getPanelSlideDescriptions(page)).length).toBe(0);
  await sendBgMessage(harness, {
    type: "slides:run",
    ok: true,
    runId: "slides-a",
    url: "https://www.youtube.com/watch?v=abc123",
  });
  await sendBgMessage(harness, { type: "ui:state", state: tabAState });
  await expect(page.locator("#title")).toHaveText("Alpha Video");

  await expect.poll(async () => (await getPanelSlideDescriptions(page)).length).toBe(1);
  const slides = await getPanelSlideDescriptions(page);
  expect(slides[0]?.[1] ?? "").toContain("Alpha");
});

test("sidepanel replaces stale slides when rerunning the same video", async ({ harness }) => {
  await seedSettings(harness, {
    token: "test-token",
    autoSummarize: false,
    slidesEnabled: true,
    slidesParallel: false,
    slidesOcrEnabled: true,
  });
  const page = await openExtensionPage(harness, "sidepanel.html", "#title");
  await waitForPanelPort(page);
  await waitForSettingsHydratedHook(page);

  await page.route("http://127.0.0.1:8787/v1/summarize/**/events", async (route) => {
    const url = route.request().url();
    if (url.includes("/slides/events")) {
      await route.fulfill({
        status: 200,
        headers: { "content-type": "text/event-stream" },
        body: ["event: done", "data: {}", ""].join("\n"),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      headers: { "content-type": "text/event-stream" },
      body: [
        "event: chunk",
        `data: ${JSON.stringify({ text: "Summary" })}`,
        "",
        "event: done",
        "data: {}",
        "",
      ].join("\n"),
    });
  });
  await page.route("http://127.0.0.1:8787/v1/summarize/**/slides", async (route) => {
    await route.fulfill({
      status: 200,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ok: false, error: "not found" }),
    });
  });
  const placeholderPng = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO3kq0cAAAAASUVORK5CYII=",
    "base64",
  );
  await page.route("http://127.0.0.1:8787/v1/slides/**", async (route) => {
    await route.fulfill({
      status: 200,
      headers: {
        "content-type": "image/png",
        "x-summarize-slide-ready": "1",
      },
      body: placeholderPng,
    });
  });

  const uiState = buildUiState({
    tab: { id: 1, url: "https://www.youtube.com/watch?v=rerun123", title: "Rerun Video" },
    media: { hasVideo: true, hasAudio: true, hasCaptions: true },
    settings: {
      autoSummarize: false,
      slidesEnabled: true,
      slidesParallel: false,
      slidesOcrEnabled: true,
      tokenPresent: true,
    },
  });
  await sendBgMessage(harness, { type: "ui:state", state: uiState });

  await sendBgMessage(harness, {
    type: "run:start",
    run: {
      id: "run-1",
      url: "https://www.youtube.com/watch?v=rerun123",
      title: "Rerun Video",
      model: "auto",
      reason: "manual",
    },
  });
  await expect.poll(async () => await getPanelSummaryMarkdown(page)).toContain("Summary");

  await page.evaluate(
    (payload) => {
      const hooks = (
        window as typeof globalThis & {
          __summarizeTestHooks?: { applySlidesPayload?: (value: unknown) => void };
        }
      ).__summarizeTestHooks;
      hooks?.applySlidesPayload?.(payload);
    },
    {
      sourceUrl: "https://www.youtube.com/watch?v=rerun123",
      sourceId: "youtube-rerun",
      sourceKind: "youtube",
      ocrAvailable: true,
      slides: [
        {
          index: 1,
          timestamp: 0,
          imageUrl: "http://127.0.0.1:8787/v1/slides/youtube-rerun/1?v=1",
          ocrText: "First run slide one.",
        },
        {
          index: 2,
          timestamp: 20,
          imageUrl: "http://127.0.0.1:8787/v1/slides/youtube-rerun/2?v=1",
          ocrText: "First run slide two.",
        },
        {
          index: 3,
          timestamp: 40,
          imageUrl: "http://127.0.0.1:8787/v1/slides/youtube-rerun/3?v=1",
          ocrText: "First run slide three.",
        },
      ],
    },
  );
  await expect.poll(async () => (await getPanelSlideDescriptions(page)).length).toBe(3);

  await sendBgMessage(harness, {
    type: "run:start",
    run: {
      id: "run-2",
      url: "https://www.youtube.com/watch?v=rerun123",
      title: "Rerun Video",
      model: "auto",
      reason: "manual",
    },
  });
  await expect.poll(async () => await getPanelSummaryMarkdown(page)).toContain("Summary");

  await page.evaluate(
    (payload) => {
      const hooks = (
        window as typeof globalThis & {
          __summarizeTestHooks?: { applySlidesPayload?: (value: unknown) => void };
        }
      ).__summarizeTestHooks;
      hooks?.applySlidesPayload?.(payload);
    },
    {
      sourceUrl: "https://www.youtube.com/watch?v=rerun123",
      sourceId: "youtube-rerun",
      sourceKind: "youtube",
      ocrAvailable: true,
      slides: [
        {
          index: 1,
          timestamp: 5,
          imageUrl: "http://127.0.0.1:8787/v1/slides/youtube-rerun/1?v=2",
          ocrText: "Second run only slide.",
        },
      ],
    },
  );

  await expect.poll(async () => (await getPanelSlideDescriptions(page)).length).toBe(1);
  const slides = await getPanelSlideDescriptions(page);
  expect(slides[0]?.[1] ?? "").toContain("Second run only slide");
  expect(slides.some(([, text]) => text.includes("First run slide two"))).toBe(false);
});

test("sidepanel starts pending slides after returning to a tab with seeded placeholders", async ({
  harness,
}) => {
  await seedSettings(harness, {
    token: "test-token",
    autoSummarize: false,
    slidesEnabled: true,
    slidesParallel: true,
    slidesOcrEnabled: true,
  });
  const page = await openExtensionPage(harness, "sidepanel.html", "#title");
  await waitForPanelPort(page);
  await waitForSettingsHydratedHook(page);
  await waitForApplySlidesHook(page);

  const targetUrl = "https://www.youtube.com/watch?v=abc123";
  const slidesPayload = buildSlidesPayload({
    sourceUrl: targetUrl,
    sourceId: "youtube-abc123",
    count: 1,
    textPrefix: "Alpha",
  });

  const summaryBody = (text: string) =>
    ["event: chunk", `data: ${JSON.stringify({ text })}`, "", "event: done", "data: {}", ""].join(
      "\n",
    );

  await page.route("http://127.0.0.1:8787/v1/summarize/summary-a/events", async (route) => {
    await route.fulfill({
      status: 200,
      headers: { "content-type": "text/event-stream" },
      body: summaryBody("Summary A"),
    });
  });
  await page.route("http://127.0.0.1:8787/v1/summarize/**/slides", async (route) => {
    await route.fulfill({
      status: 200,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ok: true, slides: slidesPayload }),
    });
  });
  await page.route("http://127.0.0.1:8787/v1/summarize/summary-a/slides/events", async (route) => {
    await route.fulfill({
      status: 200,
      headers: { "content-type": "text/event-stream" },
      body: [
        "event: slides",
        `data: ${JSON.stringify(slidesPayload)}`,
        "",
        "event: done",
        "data: {}",
        "",
      ].join("\n"),
    });
  });

  const placeholderPng = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO3kq0cAAAAASUVORK5CYII=",
    "base64",
  );
  await page.route("http://127.0.0.1:8787/v1/slides/**", async (route) => {
    await route.fulfill({
      status: 200,
      headers: {
        "content-type": "image/png",
        "x-summarize-slide-ready": "1",
      },
      body: placeholderPng,
    });
  });

  const tabAState = buildUiState({
    tab: { id: 1, url: targetUrl, title: "Alpha Video" },
    media: { hasVideo: true, hasAudio: true, hasCaptions: true },
    stats: { pageWords: 120, videoDurationSeconds: 120 },
    settings: {
      autoSummarize: false,
      slidesEnabled: true,
      slidesParallel: true,
      slidesOcrEnabled: true,
      tokenPresent: true,
    },
  });
  const tabBState = buildUiState({
    tab: { id: 2, url: "https://example.com", title: "Bravo Tab" },
    media: { hasVideo: false, hasAudio: false, hasCaptions: false },
    settings: {
      autoSummarize: false,
      slidesEnabled: true,
      slidesParallel: true,
      slidesOcrEnabled: true,
      tokenPresent: true,
    },
  });
  await sendBgMessage(harness, { type: "ui:state", state: tabAState });
  await expect(page.locator("#title")).toHaveText("Alpha Video");
  await sendBgMessage(harness, {
    type: "run:start",
    run: {
      id: "summary-a",
      url: targetUrl,
      title: "Alpha Video",
      model: "auto",
      reason: "manual",
      slides: true,
    },
  });
  await expect
    .poll(async () => (await getPanelSlidesTimeline(page)).length, { timeout: 10_000 })
    .toBe(1);

  await sendBgMessage(harness, { type: "ui:state", state: tabBState });
  await expect(page.locator("#title")).toHaveText("Bravo Tab");
  await sendBgMessage(harness, { type: "ui:state", state: tabAState });
  await expect(page.locator("#title")).toHaveText("Alpha Video");

  await expect.poll(async () => (await getPanelSlidesTimeline(page)).length).toBe(1);
  const slides = await getPanelSlideDescriptions(page);
  expect(slides.some(([, text]) => text.includes("Alpha"))).toBe(true);
});
