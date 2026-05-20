import { expect, test } from "@playwright/test";
import {
  getSummarizeBodies,
  getSummarizeCalls,
  getSummarizeLastBody,
  mockDaemonSummarize,
} from "./helpers/daemon-fixtures";
import {
  activateTabByUrl,
  assertNoErrors,
  buildUiState,
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
  waitForExtractReady,
  waitForPanelPort,
} from "./helpers/extension-harness";

test("sidepanel video selection forces transcript mode", async ({
  browserName: _browserName,
}, testInfo) => {
  const harness = await launchExtension(getBrowserFromProject(testInfo.project.name));

  try {
    await mockDaemonSummarize(harness);
    await seedSettings(harness, {
      token: "test-token",
      autoSummarize: false,
      slidesEnabled: false,
    });
    const contentPage = await harness.context.newPage();
    await contentPage.route("https://www.youtube.com/**", async (route) => {
      await route.fulfill({
        status: 200,
        headers: { "content-type": "text/html" },
        body: "<html><body><article>Video placeholder</article></body></html>",
      });
    });
    await contentPage.goto("https://www.youtube.com/watch?v=abc123", {
      waitUntil: "domcontentloaded",
    });
    await maybeBringToFront(contentPage);
    await activateTabByUrl(harness, "https://www.youtube.com/watch?v=abc123");
    await waitForActiveTabUrl(harness, "https://www.youtube.com/watch?v=abc123");
    await injectContentScript(
      harness,
      "content-scripts/extract.js",
      "https://www.youtube.com/watch?v=abc123",
    );

    const page = await openExtensionPage(harness, "sidepanel.html", "#title");
    await waitForPanelPort(page);
    const mediaState = buildUiState({
      tab: { id: 1, url: "https://www.youtube.com/watch?v=abc123", title: "Example" },
      media: { hasVideo: true, hasAudio: false, hasCaptions: false },
      stats: { pageWords: 120, videoDurationSeconds: 90 },
      settings: { slidesEnabled: false },
      status: "",
    });
    await expect
      .poll(async () => {
        await sendBgMessage(harness, { type: "ui:state", state: mediaState });
        return await page.locator(".summarizeButton.isDropdown").count();
      })
      .toBe(1);

    const sseBody = [
      "event: chunk",
      'data: {"text":"Hello world"}',
      "",
      "event: done",
      "data: {}",
      "",
    ].join("\n");
    await page.route("http://127.0.0.1:8787/v1/summarize/**", async (route) => {
      await route.fulfill({
        status: 200,
        headers: { "content-type": "text/event-stream" },
        body: sseBody,
      });
    });

    await maybeBringToFront(contentPage);
    await activateTabByUrl(harness, "https://www.youtube.com/watch?v=abc123");
    await waitForActiveTabUrl(harness, "https://www.youtube.com/watch?v=abc123");

    await sendPanelMessage(page, { type: "panel:summarize", inputMode: "video", refresh: false });
    await expect
      .poll(async () => {
        const bodies = (await getSummarizeBodies(harness)) as Array<Record<string, unknown>>;
        return bodies.some((body) => body?.videoMode === "transcript");
      })
      .toBe(true);

    const bodies = (await getSummarizeBodies(harness)) as Array<Record<string, unknown>>;
    const body = bodies.find((item) => item?.videoMode === "transcript") ?? null;
    expect(body?.mode).toBe("url");
    expect(body?.videoMode).toBe("transcript");
    assertNoErrors(harness);
  } finally {
    await closeExtension(harness.context, harness.userDataDir);
  }
});

test("sidepanel video selection requests slides when enabled", async ({
  browserName: _browserName,
}, testInfo) => {
  const harness = await launchExtension(getBrowserFromProject(testInfo.project.name));

  try {
    await mockDaemonSummarize(harness);
    await seedSettings(harness, {
      token: "test-token",
      autoSummarize: false,
      slidesEnabled: true,
      slidesOcrEnabled: true,
    });
    const contentPage = await harness.context.newPage();
    await contentPage.route("https://www.youtube.com/**", async (route) => {
      await route.fulfill({
        status: 200,
        headers: { "content-type": "text/html" },
        body: "<html><body><article>Video placeholder</article></body></html>",
      });
    });
    await contentPage.goto("https://www.youtube.com/watch?v=dQw4w9WgXcQ", {
      waitUntil: "domcontentloaded",
    });
    await maybeBringToFront(contentPage);
    await activateTabByUrl(harness, "https://www.youtube.com/watch?v=dQw4w9WgXcQ");
    await waitForActiveTabUrl(harness, "https://www.youtube.com/watch?v=dQw4w9WgXcQ");
    await injectContentScript(
      harness,
      "content-scripts/extract.js",
      "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    );

    const page = await openExtensionPage(harness, "sidepanel.html", "#title");
    await waitForPanelPort(page);
    const mediaState = buildUiState({
      tab: { id: 1, url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ", title: "Example" },
      media: { hasVideo: true, hasAudio: false, hasCaptions: false },
      stats: { pageWords: 120, videoDurationSeconds: 90 },
      settings: { slidesEnabled: true },
      status: "",
    });
    await expect
      .poll(async () => {
        await sendBgMessage(harness, { type: "ui:state", state: mediaState });
        return await page.locator(".summarizeButton.isDropdown").count();
      })
      .toBe(1);

    const sseBody = [
      "event: chunk",
      'data: {"text":"Hello world"}',
      "",
      "event: done",
      "data: {}",
      "",
    ].join("\n");
    await page.route("http://127.0.0.1:8787/v1/summarize/**", async (route) => {
      await route.fulfill({
        status: 200,
        headers: { "content-type": "text/event-stream" },
        body: sseBody,
      });
    });

    await maybeBringToFront(contentPage);
    await activateTabByUrl(harness, "https://www.youtube.com/watch?v=dQw4w9WgXcQ");
    await waitForActiveTabUrl(harness, "https://www.youtube.com/watch?v=dQw4w9WgXcQ");

    await sendPanelMessage(page, { type: "panel:summarize", inputMode: "video", refresh: false });
    await expect
      .poll(async () => {
        const bodies = (await getSummarizeBodies(harness)) as Array<Record<string, unknown>>;
        return bodies.some((body) => body?.videoMode === "transcript" && body?.slides === true);
      })
      .toBe(true);

    const bodies = (await getSummarizeBodies(harness)) as Array<Record<string, unknown>>;
    const body =
      bodies.find((item) => item?.videoMode === "transcript" && item?.slides === true) ?? null;
    expect(body?.mode).toBe("url");
    expect(body?.videoMode).toBe("transcript");
    expect(body?.slides).toBe(true);
    expect(body?.slidesOcr).toBe(true);
    expect(body).not.toHaveProperty("slidesMax");
    expect(body).not.toHaveProperty("slidesMinDuration");
    assertNoErrors(harness);
  } finally {
    await closeExtension(harness.context, harness.userDataDir);
  }
});

test("sidepanel video selection does not request slides when disabled", async ({
  browserName: _browserName,
}, testInfo) => {
  const harness = await launchExtension(getBrowserFromProject(testInfo.project.name));

  try {
    await mockDaemonSummarize(harness);
    await seedSettings(harness, {
      token: "test-token",
      autoSummarize: false,
      slidesEnabled: false,
    });
    const contentPage = await harness.context.newPage();
    await contentPage.goto("https://example.com", { waitUntil: "domcontentloaded" });
    await contentPage.evaluate(() => {
      document.body.innerHTML = `<article><p>${"Hello ".repeat(40)}</p></article>`;
    });
    await maybeBringToFront(contentPage);
    await activateTabByUrl(harness, "https://example.com");
    await waitForActiveTabUrl(harness, "https://example.com");
    await injectContentScript(harness, "content-scripts/extract.js", "https://example.com");
    await waitForExtractReady(harness, "https://example.com");

    const page = await openExtensionPage(harness, "sidepanel.html", "#title", () => {
      (window as typeof globalThis & { IntersectionObserver?: unknown }).IntersectionObserver =
        undefined;
    });
    const mediaState = buildUiState({
      tab: { id: 1, url: "https://example.com", title: "Example" },
      media: { hasVideo: true, hasAudio: false, hasCaptions: false },
      stats: { pageWords: 120, videoDurationSeconds: 90 },
      settings: { slidesEnabled: true },
      status: "",
    });
    await expect
      .poll(async () => {
        await sendBgMessage(harness, { type: "ui:state", state: mediaState });
        return await page.locator(".summarizeButton.isDropdown").count();
      })
      .toBe(1);

    const sseBody = [
      "event: chunk",
      'data: {"text":"Hello world"}',
      "",
      "event: done",
      "data: {}",
      "",
    ].join("\n");
    await page.route("http://127.0.0.1:8787/v1/summarize/**", async (route) => {
      await route.fulfill({
        status: 200,
        headers: { "content-type": "text/event-stream" },
        body: sseBody,
      });
    });

    await maybeBringToFront(contentPage);
    await activateTabByUrl(harness, "https://example.com");
    await waitForActiveTabUrl(harness, "https://example.com");

    await sendPanelMessage(page, { type: "panel:summarize", inputMode: "video", refresh: false });
    await expect.poll(() => getSummarizeCalls(harness)).toBe(1);

    const body = (await getSummarizeLastBody(harness)) as Record<string, unknown> | null;
    expect(body?.mode).toBe("url");
    expect(body?.videoMode).toBe("transcript");
    expect(body?.slides).toBeUndefined();
    expect(body?.slidesOcr).toBeUndefined();
    assertNoErrors(harness);
  } finally {
    await closeExtension(harness.context, harness.userDataDir);
  }
});

test("sidepanel loads slide images after they become ready", async ({
  browserName: _browserName,
}, testInfo) => {
  const harness = await launchExtension(getBrowserFromProject(testInfo.project.name));

  try {
    await mockDaemonSummarize(harness);
    await seedSettings(harness, { token: "test-token", autoSummarize: false, slidesEnabled: true });
    const page = await openExtensionPage(harness, "sidepanel.html", "#title", () => {
      (
        window as typeof globalThis & { __summarizeTestHooks?: Record<string, unknown> }
      ).__summarizeTestHooks = {};
    });
    await waitForPanelPort(page);
    const youtubeUrl = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
    const mediaState = buildUiState({
      tab: { id: 1, url: youtubeUrl, title: "Example Video" },
      media: { hasVideo: true, hasAudio: false, hasCaptions: false },
      stats: { pageWords: 120, videoDurationSeconds: 90 },
      status: "",
    });
    await expect
      .poll(async () => {
        await sendBgMessage(harness, { type: "ui:state", state: mediaState });
        return await page.locator(".summarizeButton.isDropdown").count();
      })
      .toBe(1);

    const slidesPayload = {
      sourceUrl: youtubeUrl,
      sourceId: "dQw4w9WgXcQ",
      sourceKind: "youtube",
      ocrAvailable: false,
      slides: [
        {
          index: 1,
          timestamp: 0,
          imageUrl: "http://127.0.0.1:8787/v1/slides/dQw4w9WgXcQ/1?v=1",
        },
      ],
    };
    await page.waitForFunction(
      () => {
        const hooks = (
          window as typeof globalThis & {
            __summarizeTestHooks?: { applySlidesPayload?: (payload: unknown) => void };
          }
        ).__summarizeTestHooks;
        return Boolean(hooks?.applySlidesPayload);
      },
      { timeout: 10_000 },
    );

    const placeholderPng = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO3kq0cAAAAASUVORK5CYII=",
      "base64",
    );
    let imageCalls = 0;
    await harness.context.route(
      "http://127.0.0.1:8787/v1/slides/dQw4w9WgXcQ/1**",
      async (route) => {
        imageCalls += 1;
        if (imageCalls < 2) {
          await route.fulfill({
            status: 200,
            headers: {
              "content-type": "image/png",
              "access-control-allow-origin": "*",
              "access-control-expose-headers": "x-summarize-slide-ready",
              "x-summarize-slide-ready": "0",
            },
            body: placeholderPng,
          });
          return;
        }
        await route.fulfill({
          status: 200,
          headers: {
            "content-type": "image/png",
            "access-control-allow-origin": "*",
            "access-control-expose-headers": "x-summarize-slide-ready",
            "x-summarize-slide-ready": "1",
          },
          body: placeholderPng,
        });
      },
    );

    await page.evaluate((payload) => {
      const hooks = (
        window as typeof globalThis & {
          __summarizeTestHooks?: {
            applySlidesPayload?: (payload: unknown) => void;
            forceRenderSlides?: () => number;
          };
        }
      ).__summarizeTestHooks;
      hooks?.applySlidesPayload?.(payload);
      hooks?.forceRenderSlides?.();
    }, slidesPayload);

    const img = page.locator("img.slideStrip__thumbImage, img.slideInline__thumbImage");
    await expect(img).toHaveCount(1, { timeout: 10_000 });
    await expect.poll(() => imageCalls, { timeout: 10_000 }).toBeGreaterThan(0);
    await expect.poll(() => imageCalls, { timeout: 10_000 }).toBeGreaterThan(1);
    await expect
      .poll(
        async () => {
          return await img.evaluate((node) => node.src);
        },
        { timeout: 10_000 },
      )
      .toContain("blob:");
    assertNoErrors(harness);
  } finally {
    await closeExtension(harness.context, harness.userDataDir);
  }
});
