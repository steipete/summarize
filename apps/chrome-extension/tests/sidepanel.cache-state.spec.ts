import { expect } from "@playwright/test";
import {
  buildSlidesPayload,
  mockDaemonSummarize,
  routePlaceholderSlideImages,
} from "./helpers/daemon-fixtures";
import { test } from "./helpers/extension-fixtures";
import {
  activateTabByUrl,
  buildUiState,
  getActiveTabId,
  openExtensionPage,
  seedSettings,
  sendBgMessage,
  waitForActiveTabUrl,
  waitForPanelPort,
} from "./helpers/extension-harness";
import {
  applySlidesPayload,
  getPanelSlideDescriptions,
  getPanelSlidesTimeline,
  getPanelSummaryMarkdown,
  waitForApplySlidesHook,
  waitForSettingsHydratedHook,
  waitForSlidesRuntimeHooks,
} from "./helpers/panel-hooks";

test("sidepanel restores cached state when switching YouTube tabs", async ({ harness }) => {
  await mockDaemonSummarize(harness);
  await seedSettings(harness, {
    token: "test-token",
    autoSummarize: false,
    slidesEnabled: true,
    slidesOcrEnabled: true,
  });
  const page = await openExtensionPage(harness, "sidepanel.html", "#title", () => {
    (
      window as typeof globalThis & { __summarizeTestHooks?: Record<string, unknown> }
    ).__summarizeTestHooks = {};
  });
  await waitForPanelPort(page);

  const sseBody = (text: string) =>
    ["event: chunk", `data: ${JSON.stringify({ text })}`, "", "event: done", "data: {}", ""].join(
      "\n",
    );
  await page.route("http://127.0.0.1:8787/v1/summarize/**/events", async (route) => {
    const url = route.request().url();
    const match = url.match(/summarize\/([^/]+)\/events/);
    const runId = match ? (match[1] ?? "") : "";
    const body = runId === "run-a" ? sseBody("Summary A") : sseBody("Summary B");
    await route.fulfill({
      status: 200,
      headers: { "content-type": "text/event-stream" },
      body,
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
    tab: { id: 1, url: "https://www.youtube.com/watch?v=alpha123", title: "Alpha Tab" },
    settings: {
      autoSummarize: false,
      slidesEnabled: true,
      slidesOcrEnabled: true,
      tokenPresent: true,
    },
    status: "",
  });
  await sendBgMessage(harness, { type: "ui:state", state: tabAState });
  await sendBgMessage(harness, {
    type: "run:start",
    run: {
      id: "run-a",
      url: "https://www.youtube.com/watch?v=alpha123",
      title: "Alpha Tab",
      model: "auto",
      reason: "manual",
      slides: false,
    },
  });
  await expect.poll(async () => await getPanelSummaryMarkdown(page)).toContain("Summary A");

  await page.waitForFunction(
    () => {
      const hooks = (
        window as typeof globalThis & {
          __summarizeTestHooks?: { applySlidesPayload?: (payload: unknown) => void };
        }
      ).__summarizeTestHooks;
      return Boolean(hooks?.applySlidesPayload);
    },
    null,
    { timeout: 5_000 },
  );
  const slidesPayloadA = {
    sourceUrl: "https://www.youtube.com/watch?v=alpha123",
    sourceId: "alpha",
    sourceKind: "url",
    ocrAvailable: true,
    slides: [
      {
        index: 1,
        timestamp: 0,
        imageUrl: "http://127.0.0.1:8787/v1/slides/alpha/1?v=1",
        ocrText: "Alpha slide one.",
      },
      {
        index: 2,
        timestamp: 12,
        imageUrl: "http://127.0.0.1:8787/v1/slides/alpha/2?v=1",
        ocrText: "Alpha slide two.",
      },
    ],
  };
  await page.evaluate((payload) => {
    const hooks = (
      window as typeof globalThis & {
        __summarizeTestHooks?: { applySlidesPayload?: (payload: unknown) => void };
      }
    ).__summarizeTestHooks;
    hooks?.applySlidesPayload?.(payload);
  }, slidesPayloadA);
  await expect.poll(async () => (await getPanelSlideDescriptions(page)).length).toBe(2);
  const slidesA = await getPanelSlideDescriptions(page);
  expect(slidesA[0]?.[1] ?? "").toContain("Alpha");

  const tabBState = buildUiState({
    tab: { id: 2, url: "https://www.youtube.com/watch?v=bravo456", title: "Bravo Tab" },
    settings: {
      autoSummarize: false,
      slidesEnabled: true,
      slidesOcrEnabled: true,
      tokenPresent: true,
    },
    status: "",
  });
  await sendBgMessage(harness, { type: "ui:state", state: tabBState });
  await expect(page.locator("#title")).toHaveText("Bravo Tab");
  await sendBgMessage(harness, {
    type: "run:start",
    run: {
      id: "run-b",
      url: "https://www.youtube.com/watch?v=bravo456",
      title: "Bravo Tab",
      model: "auto",
      reason: "manual",
      slides: false,
    },
  });
  await expect.poll(async () => await getPanelSummaryMarkdown(page)).toContain("Summary B");

  const slidesPayloadB = {
    sourceUrl: "https://www.youtube.com/watch?v=bravo456",
    sourceId: "bravo",
    sourceKind: "url",
    ocrAvailable: true,
    slides: [
      {
        index: 1,
        timestamp: 0,
        imageUrl: "http://127.0.0.1:8787/v1/slides/bravo/1?v=1",
        ocrText: "Bravo slide one.",
      },
    ],
  };
  await page.evaluate((payload) => {
    const hooks = (
      window as typeof globalThis & {
        __summarizeTestHooks?: { applySlidesPayload?: (payload: unknown) => void };
      }
    ).__summarizeTestHooks;
    hooks?.applySlidesPayload?.(payload);
  }, slidesPayloadB);
  await expect.poll(async () => (await getPanelSlideDescriptions(page)).length).toBe(1);
  const slidesB = await getPanelSlideDescriptions(page);
  expect(slidesB[0]?.[1] ?? "").toContain("Bravo");

  await sendBgMessage(harness, { type: "ui:state", state: tabAState });
  await expect(page.locator("#title")).toHaveText("Alpha Tab");
  await expect.poll(async () => await getPanelSummaryMarkdown(page)).toContain("Summary A");
  const restoredSlides = await getPanelSlideDescriptions(page);
  expect(restoredSlides[0]?.[1] ?? "").toContain("Alpha");
  expect(restoredSlides.some((entry) => entry[1].includes("Bravo"))).toBe(false);
});

test("sidepanel clears cached slides when switching from a cached YouTube video to an uncached one", async ({
  harness,
}) => {
  await mockDaemonSummarize(harness);
  await seedSettings(harness, {
    token: "test-token",
    autoSummarize: false,
    slidesEnabled: true,
    slidesParallel: true,
    slidesOcrEnabled: true,
  });
  const page = await openExtensionPage(harness, "sidepanel.html", "#title", () => {
    (
      window as typeof globalThis & { __summarizeTestHooks?: Record<string, unknown> }
    ).__summarizeTestHooks = {};
  });
  await waitForPanelPort(page);

  const sseBody = (text: string) =>
    ["event: chunk", `data: ${JSON.stringify({ text })}`, "", "event: done", "data: {}", ""].join(
      "\n",
    );
  await page.route("http://127.0.0.1:8787/v1/summarize/**/events", async (route) => {
    const runId =
      route
        .request()
        .url()
        .match(/summarize\/([^/]+)\/events/)?.[1] ?? "";
    await route.fulfill({
      status: 200,
      headers: { "content-type": "text/event-stream" },
      body: runId === "run-a" ? sseBody("Summary A") : sseBody("Summary B"),
    });
  });
  await routePlaceholderSlideImages(page);

  const tabAState = buildUiState({
    tab: { id: 1, url: "https://www.youtube.com/watch?v=alpha123", title: "Alpha Tab" },
    settings: {
      autoSummarize: false,
      slidesEnabled: true,
      slidesParallel: true,
      slidesOcrEnabled: true,
      tokenPresent: true,
    },
  });
  const tabBState = buildUiState({
    tab: { id: 2, url: "https://www.youtube.com/watch?v=bravo456", title: "Bravo Tab" },
    settings: {
      autoSummarize: false,
      slidesEnabled: true,
      slidesParallel: true,
      slidesOcrEnabled: true,
      tokenPresent: true,
    },
  });

  await sendBgMessage(harness, { type: "ui:state", state: tabAState });
  await expect(page.locator("#title")).toHaveText("Alpha Tab");
  await sendBgMessage(harness, {
    type: "run:start",
    run: {
      id: "run-a",
      url: "https://www.youtube.com/watch?v=alpha123",
      title: "Alpha Tab",
      model: "auto",
      reason: "manual",
      slides: false,
    },
  });
  await expect.poll(async () => await getPanelSummaryMarkdown(page)).toContain("Summary A");
  await waitForApplySlidesHook(page);
  await applySlidesPayload(
    page,
    buildSlidesPayload({
      sourceUrl: "https://www.youtube.com/watch?v=alpha123",
      sourceId: "youtube-alpha123",
      count: 2,
      textPrefix: "Alpha",
    }),
  );
  await expect.poll(async () => (await getPanelSlideDescriptions(page)).length).toBe(2);
  expect((await getPanelSlideDescriptions(page))[0]?.[1] ?? "").toContain("Alpha");

  await sendBgMessage(harness, { type: "ui:state", state: tabBState });
  await expect(page.locator("#title")).toHaveText("Bravo Tab");
  const emptyState = page.locator('#render [data-empty-state="true"]');
  await expect(emptyState).toContainText("Click Summarize to start.");
  await expect(emptyState).toContainText("Bravo Tab");
  await expect(page.locator("#render")).not.toContainText("Summary A");
  await expect.poll(async () => (await getPanelSlideDescriptions(page)).length).toBe(0);

  await sendBgMessage(harness, { type: "ui:state", state: tabAState });
  await expect(page.locator("#title")).toHaveText("Alpha Tab");
  await expect.poll(async () => await getPanelSummaryMarkdown(page)).toContain("Summary A");
  const restoredSlides = await getPanelSlideDescriptions(page);
  expect(restoredSlides).toHaveLength(2);
  expect(restoredSlides.every(([, text]) => text.includes("Alpha"))).toBe(true);
});

test("sidepanel keeps cached slides isolated while a different YouTube video resumes uncached slides", async ({
  harness,
}) => {
  await seedSettings(harness, {
    token: "test-token",
    autoSummarize: false,
    slidesEnabled: true,
    slidesParallel: true,
    slidesOcrEnabled: true,
  });
  const page = await openExtensionPage(harness, "sidepanel.html", "#title", () => {
    (
      window as typeof globalThis & { __summarizeTestHooks?: Record<string, unknown> }
    ).__summarizeTestHooks = {};
  });
  await waitForPanelPort(page);

  const summaryBody = (text: string) =>
    ["event: chunk", `data: ${JSON.stringify({ text })}`, "", "event: done", "data: {}", ""].join(
      "\n",
    );
  await page.route("http://127.0.0.1:8787/v1/summarize/**/events", async (route) => {
    const runId =
      route
        .request()
        .url()
        .match(/summarize\/([^/]+)\/events/)?.[1] ?? "";
    let body = summaryBody("Summary");
    if (runId === "run-a") body = summaryBody("Summary A");
    if (runId === "run-b") body = summaryBody("Summary B");
    if (runId === "slides-a") body = summaryBody("Slides summary A");
    await route.fulfill({
      status: 200,
      headers: { "content-type": "text/event-stream" },
      body,
    });
  });

  const alphaPayload = buildSlidesPayload({
    sourceUrl: "https://www.youtube.com/watch?v=alpha123",
    sourceId: "youtube-alpha123",
    count: 2,
    textPrefix: "Alpha",
  });
  await page.route("http://127.0.0.1:8787/v1/summarize/**/slides", async (route) => {
    const url = route.request().url();
    if (url.includes("/slides-a/slides")) {
      await route.fulfill({
        status: 200,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ok: true, slides: alphaPayload }),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ok: false, error: "not found" }),
    });
  });
  await page.route("http://127.0.0.1:8787/v1/summarize/slides-a/slides/events", async (route) => {
    await route.fulfill({
      status: 200,
      headers: { "content-type": "text/event-stream" },
      body: [
        "event: slides",
        `data: ${JSON.stringify(alphaPayload)}`,
        "",
        "event: done",
        "data: {}",
        "",
      ].join("\n"),
    });
  });
  await routePlaceholderSlideImages(page);

  const tabAState = buildUiState({
    tab: { id: 1, url: "https://www.youtube.com/watch?v=alpha123", title: "Alpha Tab" },
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
    tab: { id: 2, url: "https://www.youtube.com/watch?v=bravo456", title: "Bravo Tab" },
    media: { hasVideo: true, hasAudio: true, hasCaptions: true },
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
      url: "https://www.youtube.com/watch?v=alpha123",
      title: "Alpha Tab",
      model: "auto",
      reason: "manual",
    },
  });
  await expect.poll(async () => await getPanelSummaryMarkdown(page)).toContain("Summary A");

  await sendBgMessage(harness, { type: "ui:state", state: tabBState });
  await expect(page.locator("#title")).toHaveText("Bravo Tab");
  await sendBgMessage(harness, {
    type: "run:start",
    run: {
      id: "run-b",
      url: "https://www.youtube.com/watch?v=bravo456",
      title: "Bravo Tab",
      model: "auto",
      reason: "manual",
    },
  });
  await expect.poll(async () => await getPanelSummaryMarkdown(page)).toContain("Summary B");
  await waitForApplySlidesHook(page);
  await applySlidesPayload(
    page,
    buildSlidesPayload({
      sourceUrl: "https://www.youtube.com/watch?v=bravo456",
      sourceId: "youtube-bravo456",
      count: 1,
      textPrefix: "Bravo",
    }),
  );
  await expect.poll(async () => (await getPanelSlideDescriptions(page)).length).toBe(1);
  expect((await getPanelSlideDescriptions(page))[0]?.[1] ?? "").toContain("Bravo");

  await sendBgMessage(harness, {
    type: "slides:run",
    ok: true,
    runId: "slides-a",
    url: "https://www.youtube.com/watch?v=alpha123",
  });
  await expect.poll(async () => await getPanelSummaryMarkdown(page)).toContain("Summary B");
  await expect.poll(async () => (await getPanelSlidesTimeline(page)).length).toBe(1);
});

test("sidepanel keeps slide summaries isolated when switching YouTube videos mid-analysis", async ({
  harness,
}, testInfo) => {
  await seedSettings(harness, {
    token: "test-token",
    autoSummarize: false,
    slidesEnabled: true,
    slidesParallel: true,
    slidesOcrEnabled: true,
    slidesLayout: "gallery",
  });
  const page = await openExtensionPage(harness, "sidepanel.html", "#title", () => {
    (
      window as typeof globalThis & { __summarizeTestHooks?: Record<string, unknown> }
    ).__summarizeTestHooks = {};
  });
  await waitForPanelPort(page);
  await waitForSlidesRuntimeHooks(page);
  await waitForSettingsHydratedHook(page);
  await routePlaceholderSlideImages(page);
  const applyBgMessage = async (message: object) => {
    await page.evaluate((payload) => {
      const hooks = (
        window as typeof globalThis & {
          __summarizeTestHooks?: { applyBgMessage?: (value: object) => void };
        }
      ).__summarizeTestHooks;
      hooks?.applyBgMessage?.(payload);
    }, message);
  };

  const delay = async (ms: number) => await new Promise((resolve) => setTimeout(resolve, ms));
  const sseBody = (text: string) =>
    ["event: chunk", `data: ${JSON.stringify({ text })}`, "", "event: done", "data: {}", ""].join(
      "\n",
    );
  const alphaSlidesMarkdown = [
    "### Slides",
    "Slide 1 · 0:00",
    "Alpha briefing",
    "Alpha summary body one polished from the scene, not raw OCR.",
    "",
    "Slide 2 · 0:10",
    "Alpha fallout",
    "Alpha summary body two explains the fallout after the poisoned drink lands.",
  ].join("\n");
  const bravoSlidesMarkdown = [
    "### Slides",
    "Slide 1 · 0:00",
    "Bravo arrival",
    "Bravo summary body one captures the new plan after switching videos.",
    "",
    "Slide 2 · 0:10",
    "Bravo twist",
    "Bravo summary body two explains the twist in the second scene.",
  ].join("\n");
  await harness.context.route("https://www.youtube.com/**", async (route) => {
    const url = route.request().url();
    const title = url.includes("alpha123")
      ? "Alpha Tab"
      : url.includes("bravo456")
        ? "Bravo Tab"
        : "YouTube placeholder";
    await route.fulfill({
      status: 200,
      headers: { "content-type": "text/html" },
      body: `<html><head><title>${title}</title></head><body><article>${title}</article></body></html>`,
    });
  });

  await page.route("http://127.0.0.1:8787/v1/summarize/**/events", async (route) => {
    const runId =
      route
        .request()
        .url()
        .match(/summarize\/([^/]+)\/events/)?.[1] ?? "";
    if (runId === "run-a") await delay(250);
    if (runId === "slides-a") await delay(900);
    if (runId === "run-b") await delay(60);
    if (runId === "slides-b") await delay(120);

    let body = sseBody("Summary");
    if (runId === "run-a") body = sseBody("Alpha overall summary.");
    if (runId === "run-b") body = sseBody("Bravo overall summary.");
    if (runId === "slides-a") body = sseBody(alphaSlidesMarkdown);
    if (runId === "slides-b") body = sseBody(bravoSlidesMarkdown);

    await route.fulfill({
      status: 200,
      headers: { "content-type": "text/event-stream" },
      body,
    });
  });

  const alphaUrl = "https://www.youtube.com/watch?v=alpha123";
  const bravoUrl = "https://www.youtube.com/watch?v=bravo456";
  await (await harness.context.newPage()).goto(alphaUrl, { waitUntil: "domcontentloaded" });
  await (await harness.context.newPage()).goto(bravoUrl, { waitUntil: "domcontentloaded" });
  await activateTabByUrl(harness, alphaUrl);
  await waitForActiveTabUrl(harness, alphaUrl);
  const alphaTabId = await getActiveTabId(harness);
  await activateTabByUrl(harness, bravoUrl);
  await waitForActiveTabUrl(harness, bravoUrl);
  const bravoTabId = await getActiveTabId(harness);
  expect(alphaTabId).not.toBeNull();
  expect(bravoTabId).not.toBeNull();
  await activateTabByUrl(harness, alphaUrl);
  await waitForActiveTabUrl(harness, alphaUrl);
  const alphaPayload = {
    sourceUrl: alphaUrl,
    sourceId: "youtube-alpha123",
    sourceKind: "youtube",
    ocrAvailable: true,
    slides: [
      {
        index: 1,
        timestamp: 0,
        imageUrl: "http://127.0.0.1:8787/v1/slides/youtube-alpha123/1?v=1",
        ocrText: "alpha raw ocr line one that should be replaced by summary text",
      },
      {
        index: 2,
        timestamp: 10,
        imageUrl: "http://127.0.0.1:8787/v1/slides/youtube-alpha123/2?v=1",
        ocrText: "alpha raw ocr line two that should be replaced by summary text",
      },
    ],
  };
  const bravoPayload = {
    sourceUrl: bravoUrl,
    sourceId: "youtube-bravo456",
    sourceKind: "youtube",
    ocrAvailable: true,
    slides: [
      {
        index: 1,
        timestamp: 0,
        imageUrl: "http://127.0.0.1:8787/v1/slides/youtube-bravo456/1?v=1",
        ocrText: "bravo raw ocr line one that should be replaced by summary text",
      },
      {
        index: 2,
        timestamp: 10,
        imageUrl: "http://127.0.0.1:8787/v1/slides/youtube-bravo456/2?v=1",
        ocrText: "bravo raw ocr line two that should be replaced by summary text",
      },
    ],
  };

  await page.route("http://127.0.0.1:8787/v1/summarize/*/slides/events", async (route) => {
    const runId =
      route
        .request()
        .url()
        .match(/summarize\/([^/]+)\/slides\/events/)?.[1] ?? "";
    const payload =
      runId === "slides-a" ? alphaPayload : runId === "slides-b" ? bravoPayload : null;
    if (!payload) {
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
        "event: slides",
        `data: ${JSON.stringify(payload)}`,
        "",
        "event: done",
        "data: {}",
        "",
      ].join("\n"),
    });
  });
  await page.route("http://127.0.0.1:8787/v1/summarize/*/slides", async (route) => {
    const runId =
      route
        .request()
        .url()
        .match(/summarize\/([^/]+)\/slides(?:\\?.*)?$/)?.[1] ?? "";
    const payload =
      runId === "slides-a" ? alphaPayload : runId === "slides-b" ? bravoPayload : null;
    await route.fulfill({
      status: 200,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload ? { ok: true, slides: payload } : { ok: true, slides: null }),
    });
  });

  const tabAState = buildUiState({
    tab: { id: alphaTabId, url: alphaUrl, title: "Alpha Tab" },
    media: { hasVideo: true, hasAudio: true, hasCaptions: true },
    settings: {
      autoSummarize: false,
      slidesEnabled: true,
      slidesParallel: true,
      slidesOcrEnabled: true,
      slidesLayout: "gallery",
      tokenPresent: true,
    },
  });
  const tabBState = buildUiState({
    tab: { id: bravoTabId, url: bravoUrl, title: "Bravo Tab" },
    media: { hasVideo: true, hasAudio: true, hasCaptions: true },
    settings: {
      autoSummarize: false,
      slidesEnabled: true,
      slidesParallel: true,
      slidesOcrEnabled: true,
      slidesLayout: "gallery",
      tokenPresent: true,
    },
  });

  await applyBgMessage({ type: "ui:state", state: tabAState });
  await expect(page.locator("#title")).toHaveText("Alpha Tab");
  await applyBgMessage({
    type: "run:start",
    run: {
      id: "run-a",
      url: alphaUrl,
      title: "Alpha Tab",
      model: "auto",
      reason: "manual",
    },
  });
  await applyBgMessage({
    type: "slides:run",
    ok: true,
    runId: "slides-a",
    url: alphaUrl,
  });

  await activateTabByUrl(harness, bravoUrl);
  await waitForActiveTabUrl(harness, bravoUrl);
  await applyBgMessage({ type: "ui:state", state: tabBState });
  await applyBgMessage({
    type: "run:start",
    run: {
      id: "run-b",
      url: bravoUrl,
      title: "Bravo Tab",
      model: "auto",
      reason: "manual",
    },
  });
  await applyBgMessage({
    type: "slides:run",
    ok: true,
    runId: "slides-b",
    url: bravoUrl,
  });

  await expect
    .poll(
      async () => {
        await page.evaluate(() => {
          const hooks = (
            window as typeof globalThis & {
              __summarizeTestHooks?: { forceRenderSlides?: () => number | void };
            }
          ).__summarizeTestHooks;
          hooks?.forceRenderSlides?.();
        });
        const descriptions = (await getPanelSlideDescriptions(page)).map(([, text]) =>
          text.toLowerCase(),
        );
        return (
          descriptions.length === 2 &&
          descriptions.every((text) => text.includes("bravo")) &&
          descriptions.every((text) => !text.includes("alpha"))
        );
      },
      { timeout: 20_000 },
    )
    .toBe(true);

  const bravoDescriptions = await getPanelSlideDescriptions(page);
  expect((bravoDescriptions[0]?.[1] ?? "").toLowerCase()).toContain("bravo");
  expect((bravoDescriptions[1]?.[1] ?? "").toLowerCase()).toContain("bravo");
  await expect(page.locator(".slideGallery__thumb img")).toHaveCount(2);

  await page.waitForTimeout(1_200);
  const stillBravoDescriptions = await getPanelSlideDescriptions(page);
  expect(stillBravoDescriptions).toHaveLength(2);
  expect(stillBravoDescriptions.some(([, text]) => /alpha/i.test(text))).toBe(false);
  await page.screenshot({
    path: testInfo.outputPath("youtube-switch-mid-analysis-bravo.png"),
    fullPage: true,
  });
});
