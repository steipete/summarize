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
  getPanelSlideTitleEntries,
  getPanelSlidesTimeline,
  getPanelSummaryMarkdown,
  waitForApplySlidesHook,
  waitForSettingsHydratedHook,
} from "./helpers/panel-hooks";

test("sidepanel reconnects cached slide runs after tab restore", async ({ harness }) => {
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

  const sseBody = (text: string) =>
    ["event: chunk", `data: ${JSON.stringify({ text })}`, "", "event: done", "data: {}", ""].join(
      "\n",
    );
  await page.route("http://127.0.0.1:8787/v1/summarize/run-a/events", async (route) => {
    await route.fulfill({
      status: 200,
      headers: { "content-type": "text/event-stream" },
      body: sseBody("Summary A"),
    });
  });

  const slidesPayload = {
    sourceUrl: "https://www.youtube.com/watch?v=cache123",
    sourceId: "cache-run",
    sourceKind: "youtube",
    ocrAvailable: true,
    slides: [
      {
        index: 1,
        timestamp: 0,
        imageUrl: "http://127.0.0.1:8787/v1/slides/cache-run/1?v=1",
        ocrText: "Cached slide one.",
      },
    ],
  };
  const slidesStreamBody = [
    "event: slides",
    `data: ${JSON.stringify(slidesPayload)}`,
    "",
    "event: done",
    "data: {}",
    "",
  ].join("\n");
  let slidesEventsRequests = 0;
  await page.route("http://127.0.0.1:8787/v1/summarize/run-a/slides/events", async (route) => {
    slidesEventsRequests += 1;
    if (slidesEventsRequests === 1) {
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
    try {
      await route.fulfill({
        status: 200,
        headers: { "content-type": "text/event-stream" },
        body: slidesStreamBody,
      });
    } catch {
      // First request is intentionally abandoned when the tab changes.
    }
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
    tab: { id: 1, url: "https://www.youtube.com/watch?v=cache123", title: "Cached Video" },
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
    tab: { id: 2, url: "https://example.com", title: "Other Tab" },
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
  await sendBgMessage(harness, {
    type: "run:start",
    run: {
      id: "run-a",
      url: "https://www.youtube.com/watch?v=cache123",
      title: "Cached Video",
      model: "auto",
      reason: "manual",
      slides: true,
    },
  });
  await expect.poll(async () => await getPanelSummaryMarkdown(page)).toContain("Summary A");
  await expect.poll(async () => slidesEventsRequests).toBe(1);

  await sendBgMessage(harness, { type: "ui:state", state: tabBState });
  await expect(page.locator("#title")).toHaveText("Other Tab");
  await expect.poll(async () => (await getPanelSlideDescriptions(page)).length).toBe(0);

  await sendBgMessage(harness, { type: "ui:state", state: tabAState });
  await expect.poll(async () => await getPanelSummaryMarkdown(page)).toContain("Summary A");
  expect(slidesEventsRequests).toBeGreaterThanOrEqual(1);
  await expect
    .poll(async () => (await getPanelSlideDescriptions(page)).length)
    .toBeGreaterThanOrEqual(1);
});

test("sidepanel retry restarts the active single-run slide stream", async ({ harness }) => {
  await seedSettings(harness, {
    token: "test-token",
    autoSummarize: false,
    slidesEnabled: true,
    slidesParallel: true,
  });
  const url = "https://www.youtube.com/watch?v=retry12345";
  const panel = await openExtensionPage(harness, "sidepanel.html", "#title");
  await waitForPanelPort(panel);
  await waitForSettingsHydratedHook(panel);

  let slideEventsRequests = 0;
  await panel.route("http://127.0.0.1:8787/v1/summarize/**/events", async (route) => {
    const requestUrl = route.request().url();
    if (requestUrl.includes("/slides/events")) {
      slideEventsRequests += 1;
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
        `data: ${JSON.stringify({ text: "Video summary" })}`,
        "",
        "event: done",
        "data: {}",
        "",
      ].join("\n"),
    });
  });
  await panel.route("http://127.0.0.1:8787/v1/summarize/**/slides", async (route) => {
    await route.fulfill({
      status: 200,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ok: false, error: "No slides yet" }),
    });
  });

  await sendBgMessage(harness, {
    type: "ui:state",
    state: buildUiState({
      tab: { id: 1, url, title: "Retry Video" },
      media: { hasVideo: true, hasAudio: true, hasCaptions: true },
      settings: {
        autoSummarize: false,
        slidesEnabled: true,
        slidesParallel: true,
        tokenPresent: true,
      },
    }),
  });
  await sendBgMessage(harness, {
    type: "run:start",
    run: {
      id: "summary-run",
      url,
      title: "Retry Video",
      model: "auto",
      reason: "manual",
      slides: true,
    },
  });
  await expect.poll(async () => await getPanelSummaryMarkdown(panel)).toContain("Video summary");
  await expect.poll(async () => slideEventsRequests).toBe(1);

  await sendBgMessage(harness, {
    type: "slides:run",
    ok: false,
    error: "Slides request failed",
  });
  await expect(panel.locator("#slideNotice")).toContainText("Slides request failed");
  await expect(panel.locator("#slideNoticeRetry")).toBeVisible();
  await panel.evaluate(() => {
    const port = (
      window as typeof globalThis & {
        __summarizePanelPort?: { postMessage: (payload: object) => void };
        __capturedPanelMessages?: object[];
      }
    ).__summarizePanelPort;
    if (!port) throw new Error("Missing panel port");
    const captured: object[] = [];
    (window as typeof globalThis & { __capturedPanelMessages?: object[] }).__capturedPanelMessages =
      captured;
    port.postMessage = (payload: object) => {
      captured.push(payload);
    };
  });
  await panel.locator("#slideNoticeRetry").click();
  await expect.poll(async () => slideEventsRequests).toBe(2);
  const captured = await panel.evaluate(() => {
    return (
      (
        window as typeof globalThis & {
          __capturedPanelMessages?: Array<{ type?: string; refresh?: boolean }>;
        }
      ).__capturedPanelMessages ?? []
    ).map((message) => ({
      type: message.type ?? null,
      refresh: message.refresh ?? null,
    }));
  });
  expect(captured).not.toContainEqual({ type: "panel:summarize", refresh: true });
});

test("sidepanel replaces transcript slide copy with slides LLM summaries", async ({ harness }) => {
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

  const sourceUrl = "https://www.youtube.com/watch?v=llmSlides123";
  const slidesPayload = buildSlidesPayload({
    sourceUrl,
    sourceId: "youtube-llmSlides123",
    count: 2,
    textPrefix: "Raw transcript fallback",
  });
  const slidesStreamBody = [
    "event: slides",
    `data: ${JSON.stringify(slidesPayload)}`,
    "",
    "event: done",
    "data: {}",
    "",
  ].join("\n");
  await page.route("http://127.0.0.1:8787/v1/summarize/slides-llm/slides/events", async (route) => {
    await route.fulfill({
      status: 200,
      headers: { "content-type": "text/event-stream" },
      body: slidesStreamBody,
    });
  });

  const llmMarkdown = [
    "The video argues that the movie works because the premise stays emotionally grounded.",
    "",
    "[slide:1]",
    "## Blockbuster setup",
    "The LLM-written card frames the opening amnesia and spacecraft mystery without quoting the transcript.",
    "",
    "[slide:2]",
    "## Stakes and tone",
    "The LLM-written card connects the science problem to the story's warmer buddy-movie rhythm.",
  ].join("\n");
  const summaryStreamBody = [
    "event: chunk",
    `data: ${JSON.stringify({ text: llmMarkdown })}`,
    "",
    "event: done",
    "data: {}",
    "",
  ].join("\n");
  await page.route("http://127.0.0.1:8787/v1/summarize/slides-llm/events", async (route) => {
    await route.fulfill({
      status: 200,
      headers: { "content-type": "text/event-stream" },
      body: summaryStreamBody,
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

  await sendBgMessage(harness, {
    type: "ui:state",
    state: buildUiState({
      tab: { id: 1, url: sourceUrl, title: "LLM Slides" },
      media: { hasVideo: true, hasAudio: true, hasCaptions: true },
      settings: {
        autoSummarize: false,
        slidesEnabled: true,
        slidesParallel: true,
        slidesOcrEnabled: true,
        tokenPresent: true,
      },
    }),
  });
  await sendBgMessage(harness, {
    type: "slides:run",
    ok: true,
    runId: "slides-llm",
    url: sourceUrl,
  });

  await expect.poll(async () => (await getPanelSlidesTimeline(page)).length).toBe(2);
  await expect
    .poll(async () => (await getPanelSlideDescriptions(page)).map(([, text]) => text).join("\n"), {
      timeout: 10_000,
    })
    .toContain("LLM-written card");
  const descriptions = await getPanelSlideDescriptions(page);
  expect(descriptions).toHaveLength(2);
  expect(descriptions.every(([, text]) => !text.includes("Raw transcript fallback"))).toBe(true);
});

test("sidepanel streams split slide summary chunks into gallery cards", async ({ harness }) => {
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

  const sourceUrl = "https://www.youtube.com/watch?v=chunkedSlides123";
  const slidesPayload = buildSlidesPayload({
    sourceUrl,
    sourceId: "youtube-chunkedSlides123",
    count: 2,
    textPrefix: "Raw transcript fallback",
  });
  await page.route(
    "http://127.0.0.1:8787/v1/summarize/chunked-slides/slides/events",
    async (route) => {
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
    },
  );
  await page.route("http://127.0.0.1:8787/v1/summarize/chunked-slides/events", async (route) => {
    await route.fulfill({
      status: 200,
      headers: { "content-type": "text/event-stream" },
      body: [
        "event: chunk",
        `data: ${JSON.stringify({ text: "Intro paragraph.\n\n[slide:1]\n## First shared title\n" })}`,
        "",
        "event: chunk",
        `data: ${JSON.stringify({ text: "First shared card body arrives after the marker.\n\n[slide:2]\n## Second shared title\nSecond shared card body streams too." })}`,
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

  await sendBgMessage(harness, {
    type: "ui:state",
    state: buildUiState({
      tab: { id: 1, url: sourceUrl, title: "Chunked Slides" },
      media: { hasVideo: true, hasAudio: true, hasCaptions: true },
      settings: {
        autoSummarize: false,
        slidesEnabled: true,
        slidesParallel: true,
        slidesOcrEnabled: true,
        tokenPresent: true,
      },
    }),
  });
  await sendBgMessage(harness, {
    type: "slides:run",
    ok: true,
    runId: "chunked-slides",
    url: sourceUrl,
  });

  await expect.poll(async () => (await getPanelSlidesTimeline(page)).length).toBe(2);
  await expect
    .poll(async () => (await getPanelSlideDescriptions(page)).map(([, text]) => text).join("\n"), {
      timeout: 10_000,
    })
    .toContain("First shared card body arrives");
  const titles = await getPanelSlideTitleEntries(page);
  expect(titles).toContainEqual([1, "First shared title"]);
  expect(titles).toContainEqual([2, "Second shared title"]);
});

test("daemon slides use the configured port and never leak the token off-origin", async ({
  harness,
}) => {
  await seedSettings(harness, {
    token: "test-token",
    daemonPort: "8799",
    autoSummarize: false,
    slidesEnabled: true,
    slidesParallel: true,
    slidesOcrEnabled: true,
  });
  const page = await openExtensionPage(harness, "sidepanel.html", "#title");
  await waitForPanelPort(page);
  await waitForSettingsHydratedHook(page);

  const sseBody = (text: string) =>
    ["event: chunk", `data: ${JSON.stringify({ text })}`, "", "event: done", "data: {}", ""].join(
      "\n",
    );

  // Summary + slides streams are served only from the CONFIGURED port (8799): if the
  // extension still hardcoded 8787 these routes would never be hit and the run would stall.
  await page.route("http://127.0.0.1:8799/v1/summarize/run-x/events", async (route) => {
    await route.fulfill({
      status: 200,
      headers: { "content-type": "text/event-stream" },
      body: sseBody("Summary X"),
    });
  });

  const slidesPayload = {
    sourceUrl: "https://www.youtube.com/watch?v=port123",
    sourceId: "port-run",
    sourceKind: "youtube",
    ocrAvailable: true,
    slides: [
      {
        index: 1,
        timestamp: 0,
        imageUrl: "http://127.0.0.1:8799/v1/slides/port-run/1?v=1",
        ocrText: "Daemon slide one has enough OCR text to pass thresholds.",
      },
      {
        index: 2,
        timestamp: 10,
        // Hostile daemon-shaped URL on a foreign origin: must never receive the token.
        imageUrl: "http://evil.test/v1/summarize/port-run/2?v=1",
        ocrText: "Foreign slide two has enough OCR text to pass thresholds.",
      },
    ],
  };
  const slidesStreamBody = [
    "event: slides",
    `data: ${JSON.stringify(slidesPayload)}`,
    "",
    "event: done",
    "data: {}",
    "",
  ].join("\n");
  await page.route("http://127.0.0.1:8799/v1/summarize/run-x/slides/events", async (route) => {
    await route.fulfill({
      status: 200,
      headers: { "content-type": "text/event-stream" },
      body: slidesStreamBody,
    });
  });

  const placeholderPng = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO3kq0cAAAAASUVORK5CYII=",
    "base64",
  );
  let daemonImageRequests = 0;
  let daemonImageAuth: string | null = null;
  await page.route("http://127.0.0.1:8799/v1/slides/**", async (route) => {
    daemonImageRequests += 1;
    daemonImageAuth = route.request().headers().authorization ?? null;
    await route.fulfill({
      status: 200,
      headers: { "content-type": "image/png", "x-summarize-slide-ready": "1" },
      body: placeholderPng,
    });
  });
  let foreignImageRequests = 0;
  let foreignImageAuth: string | null = null;
  await page.route("http://evil.test/**", async (route) => {
    foreignImageRequests += 1;
    foreignImageAuth = route.request().headers().authorization ?? null;
    await route.fulfill({
      status: 200,
      headers: { "content-type": "image/png", "x-summarize-slide-ready": "1" },
      body: placeholderPng,
    });
  });

  const tabState = buildUiState({
    tab: { id: 1, url: "https://www.youtube.com/watch?v=port123", title: "Port Video" },
    media: { hasVideo: true, hasAudio: true, hasCaptions: true },
    settings: {
      autoSummarize: false,
      slidesEnabled: true,
      slidesParallel: true,
      slidesOcrEnabled: true,
      tokenPresent: true,
    },
  });
  await sendBgMessage(harness, { type: "ui:state", state: tabState });
  await sendBgMessage(harness, {
    type: "run:start",
    run: {
      id: "run-x",
      url: "https://www.youtube.com/watch?v=port123",
      title: "Port Video",
      model: "auto",
      reason: "manual",
      slides: true,
    },
  });

  // Custom-port proof: the run streams from 8799 and renders both slides.
  await expect.poll(async () => await getPanelSummaryMarkdown(page)).toContain("Summary X");
  await expect
    .poll(async () => (await getPanelSlideDescriptions(page)).length)
    .toBeGreaterThanOrEqual(2);
  await expect.poll(() => daemonImageRequests).toBeGreaterThanOrEqual(1);
  expect(daemonImageAuth).toBe("Bearer test-token");

  // Security: the daemon token never follows a foreign-origin slide URL.
  await page.waitForTimeout(500);
  expect(foreignImageRequests).toBe(0);
  expect(foreignImageAuth).toBeNull();
});
