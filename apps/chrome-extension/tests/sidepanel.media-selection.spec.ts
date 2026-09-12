import { expect } from "@playwright/test";
import {
  getSummarizeBodies,
  getSummarizeCalls,
  getSummarizeLastBody,
  mockDaemonSummarize,
} from "./helpers/daemon-fixtures";
import { test } from "./helpers/extension-fixtures";
import {
  activateTabByUrl,
  buildUiState,
  injectContentScript,
  maybeBringToFront,
  openExtensionPage,
  seedSettings,
  sendBgMessage,
  sendPanelMessage,
  waitForActiveTabUrl,
  waitForExtractReady,
  waitForPanelPort,
} from "./helpers/extension-harness";

test("sidepanel video selection forces transcript mode", async ({ harness }) => {
  await mockDaemonSummarize(harness);
  await seedSettings(harness, {
    token: "test-token",
    autoSummarize: false,
    slidesEnabled: false,
    slideRuntime: "daemon",
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
      return bodies.some((body) => body?.mode === "url" && !("videoMode" in body));
    })
    .toBe(true);

  const bodies = (await getSummarizeBodies(harness)) as Array<Record<string, unknown>>;
  const body = bodies.find((item) => item?.mode === "url" && !("videoMode" in item)) ?? null;
  expect(body?.mode).toBe("url");
  expect(body).not.toHaveProperty("videoMode");
});

test("sidepanel page selection on YouTube uses page text instead of captions", async ({
  harness,
}) => {
  await mockDaemonSummarize(harness);
  await seedSettings(harness, {
    token: "test-token",
    autoSummarize: false,
    slidesEnabled: false,
    slideRuntime: "daemon",
  });
  const youtubeUrl = "https://www.youtube.com/watch?v=pageMode123";
  const playerResponse = {
    captions: {
      playerCaptionsTracklistRenderer: {
        captionTracks: [
          {
            baseUrl: "https://www.youtube.com/api/timedtext?v=pageMode123&lang=en",
            languageCode: "en",
            name: { simpleText: "English" },
          },
        ],
      },
    },
    videoDetails: { lengthSeconds: "90", videoId: "pageMode123" },
  };
  const contentPage = await harness.context.newPage();
  await contentPage.route("https://www.youtube.com/**", async (route) => {
    const url = route.request().url();
    if (url.includes("/api/timedtext")) {
      await route.fulfill({
        status: 200,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          events: [{ tStartMs: 0, segs: [{ utf8: "Caption text should not be used." }] }],
        }),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      headers: { "content-type": "text/html" },
      body: `<html><head><title>Page Mode Video</title></head><body>
          <script>var ytInitialPlayerResponse = ${JSON.stringify(playerResponse)};</script>
          <article><h1>Video description</h1><p>Page description text should be used.</p></article>
        </body></html>`,
    });
  });
  await contentPage.goto(youtubeUrl, { waitUntil: "domcontentloaded" });
  await maybeBringToFront(contentPage);
  await activateTabByUrl(harness, youtubeUrl);
  await waitForActiveTabUrl(harness, youtubeUrl);
  await injectContentScript(harness, "content-scripts/extract.js", youtubeUrl);

  const page = await openExtensionPage(harness, "sidepanel.html", "#title");
  await waitForPanelPort(page);
  await page.route("http://127.0.0.1:8787/v1/summarize/**", async (route) => {
    await route.fulfill({
      status: 200,
      headers: { "content-type": "text/event-stream" },
      body: ["event: done", "data: {}", ""].join("\n"),
    });
  });
  await sendPanelMessage(page, { type: "panel:summarize", inputMode: "page", refresh: false });

  await expect.poll(async () => await getSummarizeCalls(harness)).toBeGreaterThan(0);
  const body = (await getSummarizeLastBody(harness)) as Record<string, unknown>;
  expect(String(body.text ?? "")).toContain("Page description text should be used.");
  expect(String(body.text ?? "")).not.toContain("Caption text should not be used.");
  expect(body.videoMode).toBeUndefined();
});

test("sidepanel includes browser-fetched YouTube transcript text", async ({ harness }) => {
  await mockDaemonSummarize(harness);
  await seedSettings(harness, {
    token: "test-token",
    autoSummarize: false,
    slidesEnabled: false,
    slideRuntime: "daemon",
  });
  const youtubeUrl = "https://www.youtube.com/watch?v=browserTranscript123";
  const stalePlayerResponse = {
    captions: {
      playerCaptionsTracklistRenderer: {
        captionTracks: [
          {
            baseUrl: "https://www.youtube.com/api/timedtext?v=previousVideo&lang=en",
            languageCode: "en",
            name: { simpleText: "English" },
          },
        ],
      },
    },
    videoDetails: { lengthSeconds: "12", videoId: "previousVideo" },
  };
  const playerResponse = {
    captions: {
      playerCaptionsTracklistRenderer: {
        captionTracks: [
          {
            baseUrl: "https://www.youtube.com/api/timedtext?v=browserTranscript123&lang=en",
            languageCode: "en",
            name: { simpleText: "English" },
          },
        ],
      },
    },
    videoDetails: { lengthSeconds: "90", videoId: "browserTranscript123" },
  };
  const contentPage = await harness.context.newPage();
  await contentPage.route("https://www.youtube.com/**", async (route) => {
    const url = route.request().url();
    if (url.includes("/api/timedtext")) {
      await route.fulfill({
        status: 200,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          events: [
            { tStartMs: 0, segs: [{ utf8: "First caption line." }] },
            { tStartMs: 2500, segs: [{ utf8: "Second caption line." }] },
          ],
        }),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      headers: { "content-type": "text/html" },
      body: `<html><body>
          <script>var ytInitialPlayerResponse = ${JSON.stringify(stalePlayerResponse)};</script>
          <ytd-watch-flexy id="watch"></ytd-watch-flexy>
          <script>document.getElementById("watch").playerResponse = ${JSON.stringify(playerResponse)};</script>
          <article>Video placeholder</article>
        </body></html>`,
    });
  });
  await contentPage.goto(youtubeUrl, { waitUntil: "domcontentloaded" });
  await maybeBringToFront(contentPage);
  await activateTabByUrl(harness, youtubeUrl);
  await waitForActiveTabUrl(harness, youtubeUrl);
  await injectContentScript(harness, "content-scripts/extract.js", youtubeUrl);

  const page = await openExtensionPage(harness, "sidepanel.html", "#title");
  await waitForPanelPort(page);
  await page.route("http://127.0.0.1:8787/v1/summarize/**", async (route) => {
    await route.fulfill({
      status: 200,
      headers: { "content-type": "text/event-stream" },
      body: ["event: done", "data: {}", ""].join("\n"),
    });
  });
  await sendBgMessage(harness, {
    type: "ui:state",
    state: buildUiState({
      tab: { id: 1, url: youtubeUrl, title: "Example" },
      media: { hasVideo: true, hasAudio: true, hasCaptions: true },
      settings: { slidesEnabled: false },
      status: "",
    }),
  });

  await sendPanelMessage(page, { type: "panel:summarize", inputMode: "video", refresh: false });
  await expect
    .poll(async () => {
      const body = (await getSummarizeLastBody(harness)) as Record<string, unknown> | null;
      return typeof body?.text === "string" ? body.text : "";
    })
    .toContain("First caption line");

  const body = (await getSummarizeLastBody(harness)) as Record<string, unknown>;
  expect(body.mode).toBe("page");
  expect(body.text).toContain("[0:00] First caption line.");
  expect(body.text).toContain("[0:02] Second caption line.");
  expect(body).not.toHaveProperty("slides");
});

test("sidepanel falls back to current YouTube transcript panel rows", async ({ harness }) => {
  await mockDaemonSummarize(harness);
  await seedSettings(harness, {
    token: "test-token",
    autoSummarize: false,
    slidesEnabled: true,
    slideRuntime: "daemon",
  });
  const youtubeUrl = "https://www.youtube.com/watch?v=panelTranscript123";
  const playerResponse = {
    captions: {
      playerCaptionsTracklistRenderer: {
        captionTracks: [
          {
            baseUrl: "https://www.youtube.com/api/timedtext?v=panelTranscript123&lang=en",
            languageCode: "en",
            name: { simpleText: "English (auto-generated)" },
            kind: "asr",
          },
        ],
      },
    },
    videoDetails: { lengthSeconds: "90", videoId: "panelTranscript123" },
  };
  const contentPage = await harness.context.newPage();
  await contentPage.route("https://www.youtube.com/**", async (route) => {
    const url = route.request().url();
    if (url.includes("/api/timedtext")) {
      await route.fulfill({
        status: 200,
        headers: { "content-type": "text/html; charset=UTF-8" },
        body: "",
      });
      return;
    }
    await route.fulfill({
      status: 200,
      headers: { "content-type": "text/html" },
      body: `<html><body>
	          <script>var ytInitialPlayerResponse = ${JSON.stringify(playerResponse)};</script>
	          <ytd-watch-metadata></ytd-watch-metadata>
	          <ytd-video-description-transcript-section-renderer>
	            <button>Show transcript</button>
	          </ytd-video-description-transcript-section-renderer>
	          <transcript-segment-view-model>
            <div class="ytwTranscriptSegmentViewModelTimestamp">0:00</div>
            <div class="ytwTranscriptSegmentViewModelTimestampA11yLabel">0 minutes, 0 seconds</div>
            <span class="ytAttributedStringHost" role="text">Panel first caption.</span>
          </transcript-segment-view-model>
          <transcript-segment-view-model>
            <div class="ytwTranscriptSegmentViewModelTimestamp">0:02</div>
            <div class="ytwTranscriptSegmentViewModelTimestampA11yLabel">0 minutes, 2 seconds</div>
            <span class="ytAttributedStringHost" role="text">Panel second caption.</span>
          </transcript-segment-view-model>
        </body></html>`,
    });
  });
  await contentPage.goto(youtubeUrl, { waitUntil: "domcontentloaded" });
  await maybeBringToFront(contentPage);
  await activateTabByUrl(harness, youtubeUrl);
  await waitForActiveTabUrl(harness, youtubeUrl);
  await injectContentScript(harness, "content-scripts/extract.js", youtubeUrl);

  const page = await openExtensionPage(harness, "sidepanel.html", "#title");
  await waitForPanelPort(page);
  await page.route("http://127.0.0.1:8787/v1/summarize/**", async (route) => {
    await route.fulfill({
      status: 200,
      headers: { "content-type": "text/event-stream" },
      body: ["event: done", "data: {}", ""].join("\n"),
    });
  });
  await sendBgMessage(harness, {
    type: "ui:state",
    state: buildUiState({
      tab: { id: 1, url: youtubeUrl, title: "Example" },
      media: { hasVideo: true, hasAudio: true, hasCaptions: true },
      settings: { slidesEnabled: true },
      status: "",
    }),
  });

  await sendPanelMessage(page, { type: "panel:summarize", inputMode: "video", refresh: false });
  await expect
    .poll(async () => {
      const body = (await getSummarizeLastBody(harness)) as Record<string, unknown> | null;
      return typeof body?.text === "string" ? body.text : "";
    })
    .toContain("Panel first caption");

  const body = (await getSummarizeLastBody(harness)) as Record<string, unknown>;
  expect(body.mode).toBe("url");
  expect(body.slides).toBe(true);
  expect(body.text).toContain("[0:00] Panel first caption.");
  expect(body.text).toContain("[0:02] Panel second caption.");
});

test("sidepanel video selection requests daemon slides when daemon extraction is enabled", async ({
  harness,
}) => {
  await mockDaemonSummarize(harness);
  await seedSettings(harness, {
    token: "test-token",
    autoSummarize: false,
    slidesEnabled: true,
    slideRuntime: "daemon",
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
      return bodies.some(
        (body) => body?.mode === "url" && body?.slides === true && !("videoMode" in body),
      );
    })
    .toBe(true);

  const bodies = (await getSummarizeBodies(harness)) as Array<Record<string, unknown>>;
  const body =
    bodies.find(
      (item) => item?.mode === "url" && item?.slides === true && !("videoMode" in item),
    ) ?? null;
  expect(body?.mode).toBe("url");
  expect(body).not.toHaveProperty("videoMode");
  expect(body?.slides).toBe(true);
  expect(body?.slidesOcr).toBeUndefined();
  expect(body).not.toHaveProperty("slidesMax");
  expect(body).not.toHaveProperty("slidesMinDuration");
});

test("sidepanel coalesces duplicate YouTube daemon slide summarize requests", async ({
  harness,
}) => {
  await mockDaemonSummarize(harness);
  await seedSettings(harness, {
    token: "test-token",
    autoSummarize: false,
    slidesEnabled: true,
    slideRuntime: "daemon",
  });
  const youtubeUrl = "https://www.youtube.com/watch?v=coalesce123";
  const contentPage = await harness.context.newPage();
  await contentPage.route("https://www.youtube.com/**", async (route) => {
    await route.fulfill({
      status: 200,
      headers: { "content-type": "text/html" },
      body: "<html><body><article>Video placeholder</article></body></html>",
    });
  });
  await contentPage.goto(youtubeUrl, { waitUntil: "domcontentloaded" });
  await maybeBringToFront(contentPage);
  await activateTabByUrl(harness, youtubeUrl);
  await waitForActiveTabUrl(harness, youtubeUrl);
  await injectContentScript(harness, "content-scripts/extract.js", youtubeUrl);

  const page = await openExtensionPage(harness, "sidepanel.html", "#title");
  await waitForPanelPort(page);
  await page.route("http://127.0.0.1:8787/v1/summarize/**", async (route) => {
    await route.fulfill({
      status: 200,
      headers: { "content-type": "text/event-stream" },
      body: ["event: done", "data: {}", ""].join("\n"),
    });
  });
  await sendBgMessage(harness, {
    type: "ui:state",
    state: buildUiState({
      tab: { id: 1, url: youtubeUrl, title: "Example" },
      media: { hasVideo: true, hasAudio: true, hasCaptions: true },
      settings: { slidesEnabled: true },
      status: "",
    }),
  });

  await sendPanelMessage(page, { type: "panel:summarize", inputMode: "video", refresh: false });
  await sendPanelMessage(page, { type: "panel:summarize", inputMode: "video", refresh: false });

  await expect
    .poll(async () => {
      const bodies = (await getSummarizeBodies(harness)) as Array<Record<string, unknown>>;
      return bodies.filter((body) => body?.mode === "url" && body?.slides === true).length;
    })
    .toBe(1);
  const bodies = (await getSummarizeBodies(harness)) as Array<Record<string, unknown>>;
  expect(bodies.filter((body) => body?.mode === "url" && body?.slides === true)).toHaveLength(1);
});

test("sidepanel video selection does not request slides when disabled", async ({ harness }) => {
  await mockDaemonSummarize(harness);
  await seedSettings(harness, {
    token: "test-token",
    autoSummarize: false,
    slidesEnabled: false,
    slideRuntime: "daemon",
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
});

test("sidepanel loads slide images after they become ready", async ({ harness }) => {
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
  await harness.context.route("http://127.0.0.1:8787/v1/slides/dQw4w9WgXcQ/1**", async (route) => {
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
  });

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
});
