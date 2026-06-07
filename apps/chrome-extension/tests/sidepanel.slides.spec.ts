import { expect, test } from "@playwright/test";
import { buildSlidesPayload, routePlaceholderSlideImages } from "./helpers/daemon-fixtures";
import {
  assertNoErrors,
  buildUiState,
  closeExtension,
  getBrowserFromProject,
  launchExtension,
  openExtensionPage,
  seedSettings,
  sendBgMessage,
  waitForPanelPort,
} from "./helpers/extension-harness";
import { allowFirefoxExtensionTests } from "./helpers/extension-test-config";
import {
  applySlidesPayload,
  getPanelSlideDescriptions,
  getPanelSlideSummaryEntries,
  getPanelSlideTitleEntries,
  getPanelSummaryMarkdown,
  getPanelSlidesTimeline,
  waitForApplySlidesHook,
  waitForSlidesRuntimeHooks,
  waitForSettingsHydratedHook,
  waitForTranscriptTimedTextHook,
} from "./helpers/panel-hooks";

test.skip(
  ({ browserName }) => browserName === "firefox" && !allowFirefoxExtensionTests,
  "Firefox extension tests are blocked by Playwright limitations. Set ALLOW_FIREFOX_EXTENSION_TESTS=1 to run.",
);

test("sidepanel replaces placeholder slides with the final smaller payload", async ({
  browserName: _browserName,
}, testInfo) => {
  const harness = await launchExtension(getBrowserFromProject(testInfo.project.name));

  try {
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
    await waitForSlidesRuntimeHooks(page);
    await waitForTranscriptTimedTextHook(page);
    await routePlaceholderSlideImages(page);

    await sendBgMessage(harness, {
      type: "ui:state",
      state: buildUiState({
        tab: {
          id: 1,
          url: "https://www.youtube.com/watch?v=helia123",
          title: "Helia Video",
        },
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

    await applySlidesPayload(page, {
      sourceUrl: "https://www.youtube.com/watch?v=helia123",
      sourceId: "youtube-helia123",
      sourceKind: "youtube",
      ocrAvailable: false,
      slides: [
        { index: 1, timestamp: 2, imageUrl: "", ocrText: null },
        { index: 2, timestamp: 63, imageUrl: "", ocrText: null },
      ],
    });

    await expect.poll(async () => (await getPanelSlidesTimeline(page)).length).toBe(2);

    await applySlidesPayload(
      page,
      buildSlidesPayload({
        sourceUrl: "https://www.youtube.com/watch?v=helia123",
        sourceId: "youtube-helia123",
        count: 1,
        textPrefix: "Final",
      }),
    );

    await expect.poll(async () => (await getPanelSlidesTimeline(page)).length).toBe(1);
    await expect(
      page.locator("img.slideStrip__thumbImage, img.slideInline__thumbImage"),
    ).toHaveCount(1);
    await expect(
      page.locator(
        'img.slideStrip__thumbImage[data-loaded="true"], img.slideInline__thumbImage[data-loaded="true"]',
      ),
    ).toHaveCount(1);
    const slides = await getPanelSlideDescriptions(page);
    expect(slides[0]?.[1] ?? "").toContain("Final slide 1");

    assertNoErrors(harness);
  } finally {
    await closeExtension(harness.context, harness.userDataDir);
  }
});

test("sidepanel shows planned slide placeholders before daemon slides arrive", async ({
  browserName: _browserName,
}, testInfo) => {
  const harness = await launchExtension(getBrowserFromProject(testInfo.project.name));

  try {
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
    await waitForSlidesRuntimeHooks(page);

    await page.route("http://127.0.0.1:8787/v1/summarize/planned-run/events", async (route) => {
      await route.fulfill({
        status: 200,
        headers: { "content-type": "text/event-stream" },
        body: [
          "event: status",
          `data: ${JSON.stringify({ text: "Slides: downloading video 8%" })}`,
          "",
          "event: chunk",
          `data: ${JSON.stringify({ text: "Transcript summary arrives before slide images." })}`,
          "",
          "event: done",
          "data: {}",
          "",
        ].join("\n"),
      });
    });
    await page.route("http://127.0.0.1:8787/v1/summarize/planned-run/slides", async (route) => {
      await route.fulfill({
        status: 200,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ok: false, error: "not ready" }),
      });
    });
    await page.route(
      "http://127.0.0.1:8787/v1/summarize/planned-run/slides/events",
      async (route) => {
        await route.fulfill({
          status: 200,
          headers: { "content-type": "text/event-stream" },
          body: [
            "event: status",
            `data: ${JSON.stringify({ text: "Slides: downloading video 8%" })}`,
            "",
            "event: done",
            "data: {}",
            "",
          ].join("\n"),
        });
      },
    );

    const targetUrl = "https://www.youtube.com/watch?v=planned123";
    await sendBgMessage(harness, {
      type: "ui:state",
      state: buildUiState({
        tab: { id: 1, url: targetUrl, title: "Planned Video" },
        media: { hasVideo: true, hasAudio: true, hasCaptions: true },
        stats: { pageWords: 0, videoDurationSeconds: null },
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
      type: "run:start",
      run: {
        id: "planned-run",
        url: targetUrl,
        title: "Planned Video",
        model: "auto",
        reason: "manual",
        slides: true,
      },
    });

    await expect.poll(async () => (await getPanelSlidesTimeline(page)).length).toBe(6);
    await expect(page.locator(".renderEmpty")).toHaveCount(0);
    await expect(page.locator(".slideGallery__item")).toHaveCount(6);
    await expect(page.locator("#render")).not.toContainText("Preparing summary");

    const durationState = buildUiState({
      tab: { id: 1, url: targetUrl, title: "Planned Video" },
      media: { hasVideo: true, hasAudio: true, hasCaptions: true },
      stats: { pageWords: 0, videoDurationSeconds: 1200 },
      settings: {
        autoSummarize: false,
        slidesEnabled: true,
        slidesParallel: true,
        slidesOcrEnabled: true,
        tokenPresent: true,
      },
    });
    await sendBgMessage(harness, {
      type: "ui:state",
      state: durationState,
    });

    await expect
      .poll(async () => {
        const timeline = await getPanelSlidesTimeline(page);
        return {
          count: timeline.length,
          finiteTimestamps: timeline.filter((slide) => slide.timestamp !== null).length,
        };
      })
      .toEqual({ count: 7, finiteTimestamps: 7 });

    assertNoErrors(harness);
  } finally {
    await closeExtension(harness.context, harness.userDataDir);
  }
});

test("sidepanel does not reseed planned slides over resolved direct video slides", async ({
  browserName: _browserName,
}, testInfo) => {
  const harness = await launchExtension(getBrowserFromProject(testInfo.project.name));

  try {
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
    await waitForSlidesRuntimeHooks(page);

    await page.route("http://127.0.0.1:8787/v1/summarize/direct-run/events", async (route) => {
      await route.fulfill({
        status: 200,
        headers: { "content-type": "text/event-stream" },
        body: [
          "event: status",
          `data: ${JSON.stringify({ text: "Slides: downloading video 8%" })}`,
          "",
          "event: chunk",
          `data: ${JSON.stringify({ text: "Direct video summary." })}`,
          "",
          "event: done",
          "data: {}",
          "",
        ].join("\n"),
      });
    });
    await page.route("http://127.0.0.1:8787/v1/summarize/direct-run/slides", async (route) => {
      await route.fulfill({
        status: 200,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ok: false, error: "not ready" }),
      });
    });
    await page.route(
      "http://127.0.0.1:8787/v1/summarize/direct-run/slides/events",
      async (route) => {
        await route.fulfill({
          status: 200,
          headers: { "content-type": "text/event-stream" },
          body: ["event: done", "data: {}", ""].join("\n"),
        });
      },
    );

    const targetUrl = "https://cdn.example.com/video.mp4";
    const stateWithoutDuration = buildUiState({
      tab: { id: 1, url: targetUrl, title: "Direct Video" },
      media: { hasVideo: true, hasAudio: true, hasCaptions: false },
      stats: { pageWords: 0, videoDurationSeconds: null },
      settings: {
        autoSummarize: false,
        slidesEnabled: true,
        slidesParallel: true,
        slidesOcrEnabled: true,
        tokenPresent: true,
      },
    });
    await sendBgMessage(harness, { type: "ui:state", state: stateWithoutDuration });
    await sendBgMessage(harness, {
      type: "run:start",
      run: {
        id: "direct-run",
        url: targetUrl,
        title: "Direct Video",
        model: "auto",
        reason: "manual",
        slides: true,
      },
    });

    await expect.poll(async () => (await getPanelSlidesTimeline(page)).length).toBe(6);
    await routePlaceholderSlideImages(page);

    await applySlidesPayload(page, {
      sourceUrl: targetUrl,
      sourceId: "cdn-example-video-deadbeef",
      sourceKind: "direct",
      ocrAvailable: false,
      slides: [
        {
          index: 1,
          timestamp: 12,
          imageUrl: "http://127.0.0.1:8787/v1/slides/cdn-example-video-deadbeef/1?v=1",
          ocrText: null,
          ocrConfidence: null,
        },
      ],
    });

    await expect.poll(async () => (await getPanelSlidesTimeline(page)).length).toBe(1);
    await sendBgMessage(harness, { type: "ui:state", state: stateWithoutDuration });
    await expect.poll(async () => (await getPanelSlidesTimeline(page)).length).toBe(1);

    assertNoErrors(harness);
  } finally {
    await closeExtension(harness.context, harness.userDataDir);
  }
});

test("sidepanel shows gallery before intro and hides gallery heading in slide mode", async ({
  browserName: _browserName,
}, testInfo) => {
  const harness = await launchExtension(getBrowserFromProject(testInfo.project.name));

  try {
    await seedSettings(harness, {
      token: "test-token",
      autoSummarize: false,
      slidesEnabled: true,
      slidesParallel: true,
      slidesOcrEnabled: true,
      slidesLayout: "strip",
    });
    const page = await openExtensionPage(harness, "sidepanel.html", "#title");
    await waitForPanelPort(page);
    await waitForSettingsHydratedHook(page);
    await waitForSlidesRuntimeHooks(page);

    await sendBgMessage(harness, {
      type: "ui:state",
      state: buildUiState({
        tab: {
          id: 1,
          url: "https://www.youtube.com/watch?v=heliafast",
          title: "Helia Video",
        },
        media: { hasVideo: true, hasAudio: true, hasCaptions: true },
        stats: { pageWords: 120, videoDurationSeconds: 120 },
        settings: {
          autoSummarize: false,
          slidesEnabled: true,
          slidesParallel: true,
          slidesOcrEnabled: true,
          slidesLayout: "strip",
          tokenPresent: true,
        },
      }),
    });

    await applySlidesPayload(page, {
      sourceUrl: "https://www.youtube.com/watch?v=heliafast",
      sourceId: "youtube-heliafast",
      sourceKind: "youtube",
      ocrAvailable: false,
      slides: [
        { index: 1, timestamp: 2, imageUrl: "", ocrText: "Helia returns to command." },
        { index: 2, timestamp: 60, imageUrl: "", ocrText: null },
      ],
    });

    await expect
      .poll(
        async () => (await getPanelSlideDescriptions(page)).map(([, text]) => text).join("\n"),
        { timeout: 10_000 },
      )
      .toContain("Helia returns to command.");
    await page.evaluate(() => {
      const hooks = (
        window as typeof globalThis & {
          __summarizeTestHooks?: { forceRenderSlides?: () => number };
        }
      ).__summarizeTestHooks;
      hooks?.forceRenderSlides?.();
    });
    await expect(page.locator(".slideGallery")).toHaveCount(1);
    await expect(page.locator(".slideStrip")).toHaveCount(0);

    await page.evaluate((markdown) => {
      const hooks = (
        window as typeof globalThis & {
          __summarizeTestHooks?: {
            applySummaryMarkdown?: (value: string) => void;
          };
        }
      ).__summarizeTestHooks;
      hooks?.applySummaryMarkdown?.(markdown);
    }, "Overall summary that should stay hidden in slide mode.");

    await expect(page.locator("#render")).not.toContainText(
      "Overall summary that should stay hidden in slide mode.",
    );

    await page.evaluate((markdown) => {
      const hooks = (
        window as typeof globalThis & {
          __summarizeTestHooks?: {
            applySummaryMarkdown?: (value: string) => void;
            forceRenderSlides?: () => number;
          };
        }
      ).__summarizeTestHooks;
      hooks?.applySummaryMarkdown?.(markdown);
      hooks?.forceRenderSlides?.();
    }, ["Intro before the first slide.", "", "[slide:1]", "## First card", "First card body.", "", "[slide:2]", "## Second card", "Second card body."].join("\n"));

    await expect(page.locator(".render__markdownHost")).toContainText(
      "Intro before the first slide.",
    );
    await expect(page.locator("#render")).not.toContainText("Slides (2)");
    await expect(page.locator(".slideGallery__title")).toHaveCount(0);
    const renderOrder = await page
      .locator("#render")
      .evaluate((el) => Array.from(el.children).map((child) => child.className));
    expect(renderOrder).toEqual(["render__slidesHost", "render__markdownHost"]);

    await expect(
      page.locator(
        'img.slideStrip__thumbImage[data-loaded="true"], img.slideInline__thumbImage[data-loaded="true"]',
      ),
    ).toHaveCount(0);

    assertNoErrors(harness);
  } finally {
    await closeExtension(harness.context, harness.userDataDir);
  }
});

test("sidepanel replaces partial slide-stream fragments with the final slide summary", async ({
  browserName: _browserName,
}, testInfo) => {
  const harness = await launchExtension(getBrowserFromProject(testInfo.project.name));

  try {
    await seedSettings(harness, {
      token: "test-token",
      autoSummarize: false,
      slidesEnabled: true,
      slidesParallel: true,
      slidesOcrEnabled: true,
      slidesLayout: "gallery",
    });
    const page = await openExtensionPage(harness, "sidepanel.html", "#title");
    await waitForPanelPort(page);
    await waitForSettingsHydratedHook(page);
    await waitForSlidesRuntimeHooks(page);
    await waitForTranscriptTimedTextHook(page);
    await routePlaceholderSlideImages(page);

    await sendBgMessage(harness, {
      type: "ui:state",
      state: buildUiState({
        tab: {
          id: 1,
          url: "https://www.youtube.com/watch?v=delenn123",
          title: "Delenn Explains",
        },
        media: { hasVideo: true, hasAudio: true, hasCaptions: true },
        settings: {
          autoSummarize: false,
          slidesEnabled: true,
          slidesParallel: true,
          slidesOcrEnabled: true,
          slidesLayout: "gallery",
          tokenPresent: true,
        },
      }),
    });

    await applySlidesPayload(page, {
      sourceUrl: "https://www.youtube.com/watch?v=delenn123",
      sourceId: "youtube-delenn123",
      sourceKind: "youtube",
      ocrAvailable: false,
      slides: [
        { index: 1, timestamp: 3, imageUrl: "", ocrText: null },
        { index: 2, timestamp: 47, imageUrl: "", ocrText: null },
      ],
    });
    await page.evaluate(() => {
      const hooks = (
        window as typeof globalThis & {
          __summarizeTestHooks?: {
            setTranscriptTimedText?: (value: string | null) => void;
            applySlidesSummaryMarkdown?: (markdown: string) => void;
            forceRenderSlides?: () => number | void;
          };
        }
      ).__summarizeTestHooks;
      hooks?.setTranscriptTimedText?.(
        "[00:03] Raw transcript line that must not remain visible.\n[00:47] More raw transcript that should be replaced.",
      );
      hooks?.applySlidesSummaryMarkdown?.("[slide:1]\n##");
      hooks?.forceRenderSlides?.();
    });

    await expect
      .poll(
        async () => (await getPanelSlideDescriptions(page)).map(([, text]) => text).join("\n"),
        { timeout: 10_000 },
      )
      .toContain("Raw transcript line");

    await page.evaluate((markdown) => {
      const hooks = (
        window as typeof globalThis & {
          __summarizeTestHooks?: {
            applySummaryMarkdown?: (value: string) => void;
            forceRenderSlides?: () => number | void;
          };
        }
      ).__summarizeTestHooks;
      hooks?.applySummaryMarkdown?.(markdown);
      hooks?.forceRenderSlides?.();
    }, ["A compact scene summary.", "", "[slide:1]", "## Ancient enemy returns", "Delenn explains that the Shadows are an ancient enemy returning after millennia.", "", "[slide:2]", "## Kosh's hidden identity", "Kosh is framed as the remaining guardian watching for signs of the Shadows."].join("\n"));

    await expect
      .poll(
        async () => (await getPanelSlideDescriptions(page)).map(([, text]) => text).join("\n"),
        { timeout: 10_000 },
      )
      .toContain("ancient enemy returning");
    const slides = await getPanelSlideDescriptions(page);
    expect(slides[0]?.[1] ?? "").not.toBe("##");
    expect(slides.some(([, text]) => text.includes("Raw transcript"))).toBe(false);
    expect(slides[1]?.[1] ?? "").toContain("remaining guardian");

    assertNoErrors(harness);
  } finally {
    await closeExtension(harness.context, harness.userDataDir);
  }
});

test("sidepanel applies existing summary text when local slides arrive after the summary", async ({
  browserName: _browserName,
}, testInfo) => {
  const harness = await launchExtension(getBrowserFromProject(testInfo.project.name));

  try {
    await seedSettings(harness, {
      token: "test-token",
      autoSummarize: false,
      slidesEnabled: true,
      slidesParallel: true,
      slidesOcrEnabled: true,
      slidesLayout: "gallery",
    });
    const page = await openExtensionPage(harness, "sidepanel.html", "#title");
    await waitForPanelPort(page);
    await waitForSettingsHydratedHook(page);
    await waitForSlidesRuntimeHooks(page);
    await waitForTranscriptTimedTextHook(page);
    await routePlaceholderSlideImages(page);

    const targetUrl = "https://www.youtube.com/watch?v=localrace123";
    await sendBgMessage(harness, {
      type: "ui:state",
      state: buildUiState({
        tab: {
          id: 1,
          url: targetUrl,
          title: "Local Race Video",
        },
        media: { hasVideo: true, hasAudio: true, hasCaptions: true },
        settings: {
          autoSummarize: false,
          slidesEnabled: true,
          slidesParallel: true,
          slidesOcrEnabled: true,
          slidesLayout: "gallery",
          tokenPresent: true,
        },
      }),
    });

    await page.evaluate((markdown) => {
      const hooks = (
        window as typeof globalThis & {
          __summarizeTestHooks?: {
            applySummaryMarkdown?: (value: string) => void;
            setTranscriptTimedText?: (value: string | null) => void;
          };
        }
      ).__summarizeTestHooks;
      hooks?.setTranscriptTimedText?.(
        [
          "[00:00] raw transcript one should not become the slide card copy.",
          "[01:03] raw transcript two should not become the slide card copy.",
          "[02:07] raw transcript three should not become the slide card copy.",
          "[03:05] raw transcript four should not become the slide card copy.",
          "[04:12] raw transcript five should not become the slide card copy.",
          "[05:01] raw transcript six should not become the slide card copy.",
        ].join("\n"),
      );
      hooks?.applySummaryMarkdown?.(markdown);
    }, ["This scene contrasts the family's chaotic defensiveness with Dr. Wong's calm patience.", "", "Rick arrives transformed and uses the spectacle to dodge emotional accountability.", "", "Dr. Wong reframes the room as a place for boring, repetitive repair rather than heroics."].join("\n"));

    await page.route("http://127.0.0.1:8787/v1/summarize/localrace-run/events", async (route) => {
      await route.fulfill({
        status: 200,
        headers: { "content-type": "text/event-stream" },
        body: ["event: done", "data: {}", ""].join("\n"),
      });
    });
    await sendBgMessage(harness, {
      type: "run:start",
      run: {
        id: "localrace-run",
        url: targetUrl,
        title: "Local Race Video",
        model: "auto",
        reason: "manual",
        slides: false,
      },
    });
    await expect.poll(async () => await getPanelSummaryMarkdown(page)).toBe("");
    await expect
      .poll(async () =>
        page.evaluate(() => {
          const hooks = (
            window as typeof globalThis & {
              __summarizeTestHooks?: { getRetainedSlideSummaryMarkdown?: () => string };
            }
          ).__summarizeTestHooks;
          return hooks?.getRetainedSlideSummaryMarkdown?.() ?? "";
        }),
      )
      .toContain("transformed and uses the spectacle");

    await applySlidesPayload(page, {
      sourceUrl: targetUrl,
      sourceId: "youtube-localrace123",
      sourceKind: "youtube",
      ocrAvailable: false,
      transcriptTimedText: [
        "[00:00] raw transcript one should not become the slide card copy.",
        "[01:03] raw transcript two should not become the slide card copy.",
        "[02:07] raw transcript three should not become the slide card copy.",
        "[03:05] raw transcript four should not become the slide card copy.",
        "[04:12] raw transcript five should not become the slide card copy.",
        "[05:01] raw transcript six should not become the slide card copy.",
      ].join("\n"),
      slides: [
        { index: 1, timestamp: 0, imageUrl: "", ocrText: null },
        { index: 2, timestamp: 63, imageUrl: "", ocrText: null },
        { index: 3, timestamp: 127, imageUrl: "", ocrText: null },
        { index: 4, timestamp: 185, imageUrl: "", ocrText: null },
        { index: 5, timestamp: 252, imageUrl: "", ocrText: null },
        { index: 6, timestamp: 301, imageUrl: "", ocrText: null },
      ],
    });

    await expect
      .poll(
        async () => (await getPanelSlideDescriptions(page)).map(([, text]) => text).join("\n"),
        { timeout: 10_000 },
      )
      .toContain("transformed and uses the spectacle");

    const slides = await getPanelSlideDescriptions(page);
    expect(slides).toHaveLength(6);
    expect(slides.some(([, text]) => text.includes("raw transcript"))).toBe(false);
    expect(slides[0]?.[1] ?? "").toContain("chaotic defensiveness");
    expect(slides[1]?.[1] ?? "").toContain("chaotic defensiveness");
    expect(slides[2]?.[1] ?? "").toContain("transformed and uses the spectacle");
    expect(slides[4]?.[1] ?? "").toContain("boring, repetitive repair");

    assertNoErrors(harness);
  } finally {
    await closeExtension(harness.context, harness.userDataDir);
  }
});

test("sidepanel scrolls YouTube slides and shows text for each slide", async ({
  browserName: _browserName,
}, testInfo) => {
  const harness = await launchExtension(getBrowserFromProject(testInfo.project.name));

  try {
    await seedSettings(harness, {
      token: "test-token",
      autoSummarize: false,
      slidesEnabled: true,
      slidesLayout: "gallery",
      slidesOcrEnabled: true,
    });
    const page = await openExtensionPage(harness, "sidepanel.html", "#title");
    await waitForPanelPort(page);
    await waitForSettingsHydratedHook(page);

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

    const sourceUrl = "https://www.youtube.com/watch?v=scrollTest123";
    const uiState = buildUiState({
      tab: { id: 1, url: sourceUrl, title: "Scroll Test" },
      media: { hasVideo: true, hasAudio: true, hasCaptions: false },
      stats: { pageWords: 120, videoDurationSeconds: 600 },
      settings: {
        autoSummarize: false,
        slidesEnabled: true,
        slidesOcrEnabled: true,
        slidesLayout: "gallery",
        tokenPresent: true,
      },
      status: "",
    });
    await sendBgMessage(harness, { type: "ui:state", state: uiState });

    await waitForApplySlidesHook(page);

    const slidesPayload = buildSlidesPayload({
      sourceUrl,
      sourceId: "yt-scroll",
      count: 12,
      textPrefix: "YouTube",
    });
    await page.evaluate((payload) => {
      const hooks = (
        window as typeof globalThis & {
          __summarizeTestHooks?: {
            applySlidesPayload?: (payload: unknown) => void;
          };
        }
      ).__summarizeTestHooks;
      hooks?.applySlidesPayload?.(payload);
    }, slidesPayload);

    await expect.poll(async () => (await getPanelSlideDescriptions(page)).length).toBe(12);
    const renderedCount = await page.evaluate(() => {
      const hooks = (
        window as typeof globalThis & {
          __summarizeTestHooks?: { forceRenderSlides?: () => number };
        }
      ).__summarizeTestHooks;
      return hooks?.forceRenderSlides?.() ?? 0;
    });
    expect(renderedCount).toBeGreaterThan(0);

    const slideItems = page.locator(".slideGallery__item");
    await expect(slideItems).toHaveCount(12);

    const galleryList = page.locator(".slideGallery__list");
    await expect(galleryList).toBeVisible();
    await galleryList.evaluate((node) => {
      node.scrollTop = node.scrollHeight;
    });
    await expect(slideItems.nth(11)).toBeVisible();

    await expect
      .poll(async () =>
        page.evaluate(() =>
          Array.from(
            document.querySelectorAll<HTMLImageElement>("img.slideInline__thumbImage"),
          ).every((img) => (img.dataset.slideImageUrl ?? "").trim().length > 0),
        ),
      )
      .toBe(true);

    await expect
      .poll(async () =>
        page.evaluate(() =>
          Array.from(document.querySelectorAll<HTMLElement>(".slideGallery__text")).every(
            (el) => (el.textContent ?? "").trim().length > 0,
          ),
        ),
      )
      .toBe(true);

    const slideDescriptions = await getPanelSlideDescriptions(page);
    expect(slideDescriptions).toHaveLength(12);
    expect(slideDescriptions.every(([, text]) => text.trim().length > 0)).toBe(true);

    assertNoErrors(harness);
  } finally {
    await closeExtension(harness.context, harness.userDataDir);
  }
});
