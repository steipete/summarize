import { expect, test } from "@playwright/test";
import { coerceSummaryWithSlides } from "../../../src/run/flows/url/slides-text.js";
import {
  DAEMON_PORT,
  SLIDES_MAX,
  hasFfmpeg,
  hasYtDlp,
  isPortInUse,
  normalizeWhitespace,
  overlapRatio,
  parseSlidesFromSummary,
  readDaemonToken,
  resolveSlidesLengthArg,
  runCliSummary,
  startDaemonSummaryRun,
} from "./helpers/daemon-fixtures";
import {
  activateTabByUrl,
  assertNoErrors,
  buildUiState,
  closeExtension,
  getActiveTabId,
  getBrowserFromProject,
  launchExtension,
  maybeBringToFront,
  openExtensionPage,
  seedSettings,
  sendBgMessage,
  waitForActiveTabUrl,
  waitForPanelPort,
} from "./helpers/extension-harness";
import {
  getPanelModel,
  getPanelPhase,
  getPanelSlideDescriptions,
  getPanelSlidesSummaryComplete,
  getPanelSlidesSummaryMarkdown,
  getPanelSlidesTimeline,
  getPanelSummaryMarkdown,
  getPanelTranscriptTimedText,
} from "./helpers/panel-hooks";

const allowFirefoxExtensionTests = process.env.ALLOW_FIREFOX_EXTENSION_TESTS === "1";
const allowYouTubeE2E = process.env.ALLOW_YOUTUBE_E2E === "1";
const youtubeEnvUrls =
  typeof process.env.SUMMARIZE_YOUTUBE_URLS === "string"
    ? process.env.SUMMARIZE_YOUTUBE_URLS.split(",").map((value) => value.trim())
    : [];
const youtubeSlidesEnvUrls =
  typeof process.env.SUMMARIZE_YOUTUBE_SLIDES_URLS === "string"
    ? process.env.SUMMARIZE_YOUTUBE_SLIDES_URLS.split(",").map((value) => value.trim())
    : [];
const defaultYouTubeUrls = [
  "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
  "https://www.youtube.com/watch?v=jNQXAC9IVRw",
];
const defaultYouTubeSlidesUrls = [
  "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
  "https://www.youtube.com/watch?v=jNQXAC9IVRw",
];
const youtubeTestUrls =
  youtubeEnvUrls.filter((value) => value.length > 0).length > 0
    ? youtubeEnvUrls.filter((value) => value.length > 0)
    : defaultYouTubeUrls;
const youtubeSlidesTestUrls =
  youtubeSlidesEnvUrls.filter((value) => value.length > 0).length > 0
    ? youtubeSlidesEnvUrls.filter((value) => value.length > 0)
    : defaultYouTubeSlidesUrls;

test.skip(
  ({ browserName }) => browserName === "firefox" && !allowFirefoxExtensionTests,
  "Firefox extension tests are blocked by Playwright limitations. Set ALLOW_FIREFOX_EXTENSION_TESTS=1 to run.",
);

test.describe("youtube e2e", () => {
  test("youtube regular summary matches cli output", async ({
    browserName: _browserName,
  }, testInfo) => {
    test.setTimeout(900_000);
    if (!allowYouTubeE2E) {
      test.skip(true, "Set ALLOW_YOUTUBE_E2E=1 to run YouTube E2E tests.");
    }
    if (testInfo.project.name === "firefox") {
      test.skip(true, "YouTube E2E is only validated in Chromium.");
    }
    const token = readDaemonToken();
    if (!token) {
      test.skip(
        true,
        "Daemon token missing (set SUMMARIZE_DAEMON_TOKEN or ~/.summarize/daemon.json).",
      );
    }
    if (!(await isPortInUse(DAEMON_PORT))) {
      test.skip(true, `Daemon must be running on ${DAEMON_PORT}.`);
    }

    const harness = await launchExtension(getBrowserFromProject(testInfo.project.name));

    try {
      const length = "short";
      await seedSettings(harness, {
        token,
        autoSummarize: false,
        slidesEnabled: false,
        slidesParallel: true,
        length,
      });

      const page = await openExtensionPage(harness, "sidepanel.html", "#title", () => {
        (
          window as typeof globalThis & { __summarizeTestHooks?: Record<string, unknown> }
        ).__summarizeTestHooks = {};
      });
      await waitForPanelPort(page);

      const contentPage = await harness.context.newPage();

      for (const url of youtubeTestUrls) {
        const runId = await startDaemonSummaryRun({ url, token, length, slides: false });

        await contentPage.goto(url, { waitUntil: "domcontentloaded" });
        await maybeBringToFront(contentPage);
        await activateTabByUrl(harness, "https://www.youtube.com/watch");
        await waitForActiveTabUrl(harness, "https://www.youtube.com/watch");
        const activeTabId = await getActiveTabId(harness);

        await sendBgMessage(harness, {
          type: "ui:state",
          state: buildUiState({
            tab: { id: activeTabId, url, title: "YouTube" },
            media: { hasVideo: true, hasAudio: false, hasCaptions: true },
            settings: { autoSummarize: false, slidesEnabled: false, slidesParallel: true, length },
          }),
        });

        await sendBgMessage(harness, {
          type: "run:start",
          run: { id: runId, url, title: "YouTube", model: "auto", reason: "test" },
        });

        await expect.poll(async () => await getPanelPhase(page), { timeout: 420_000 }).toBe("idle");

        const cliSummary = runCliSummary(url, [
          "--json",
          "--length",
          length,
          "--language",
          "auto",
          "--model",
          "auto",
          "--video-mode",
          "transcript",
          "--timestamps",
        ]);
        const panelSummary = await getPanelSummaryMarkdown(page);
        const normalizedPanel = normalizeWhitespace(panelSummary);
        const normalizedCli = normalizeWhitespace(cliSummary);
        expect(normalizedPanel.length).toBeGreaterThan(0);
        expect(normalizedCli.length).toBeGreaterThan(0);
        expect(overlapRatio(normalizedPanel, normalizedCli)).toBeGreaterThan(0.2);
      }

      assertNoErrors(harness);
    } finally {
      await closeExtension(harness.context, harness.userDataDir);
    }
  });

  test("youtube slides summary matches cli output", async ({
    browserName: _browserName,
  }, testInfo) => {
    test.setTimeout(1_200_000);
    if (!allowYouTubeE2E) {
      test.skip(true, "Set ALLOW_YOUTUBE_E2E=1 to run YouTube E2E tests.");
    }
    if (testInfo.project.name === "firefox") {
      test.skip(true, "YouTube E2E is only validated in Chromium.");
    }
    if (!hasFfmpeg() || !hasYtDlp()) {
      test.skip(true, "yt-dlp + ffmpeg are required for YouTube slide extraction.");
    }
    const token = readDaemonToken();
    if (!token) {
      test.skip(
        true,
        "Daemon token missing (set SUMMARIZE_DAEMON_TOKEN or ~/.summarize/daemon.json).",
      );
    }
    if (!(await isPortInUse(DAEMON_PORT))) {
      test.skip(true, `Daemon must be running on ${DAEMON_PORT}.`);
    }

    const harness = await launchExtension(getBrowserFromProject(testInfo.project.name));

    try {
      const length = "short";
      await seedSettings(harness, {
        token,
        autoSummarize: false,
        slidesEnabled: true,
        slidesParallel: true,
        length,
      });

      const page = await openExtensionPage(harness, "sidepanel.html", "#title", () => {
        (
          window as typeof globalThis & { __summarizeTestHooks?: Record<string, unknown> }
        ).__summarizeTestHooks = {};
      });
      await waitForPanelPort(page);

      const contentPage = await harness.context.newPage();

      for (const url of youtubeSlidesTestUrls) {
        const summaryRunId = await startDaemonSummaryRun({ url, token, length, slides: false });
        const slidesRunId = await startDaemonSummaryRun({
          url,
          token,
          length,
          slides: true,
          slidesMax: SLIDES_MAX,
        });

        await contentPage.goto(url, { waitUntil: "domcontentloaded" });
        await maybeBringToFront(contentPage);
        await activateTabByUrl(harness, "https://www.youtube.com/watch");
        await waitForActiveTabUrl(harness, "https://www.youtube.com/watch");
        const activeTabId = await getActiveTabId(harness);

        await sendBgMessage(harness, {
          type: "ui:state",
          state: buildUiState({
            tab: { id: activeTabId, url, title: "YouTube" },
            media: { hasVideo: true, hasAudio: false, hasCaptions: true },
            settings: { autoSummarize: false, slidesEnabled: true, slidesParallel: true, length },
          }),
        });

        await sendBgMessage(harness, {
          type: "run:start",
          run: { id: summaryRunId, url, title: "YouTube", model: "auto", reason: "test" },
        });
        await sendBgMessage(harness, {
          type: "slides:run",
          ok: true,
          runId: slidesRunId,
          url,
        });

        await expect.poll(async () => await getPanelPhase(page), { timeout: 420_000 }).toBe("idle");
        await expect
          .poll(async () => (await getPanelModel(page)) ?? "", { timeout: 120_000 })
          .not.toBe("");

        await expect
          .poll(async () => (await getPanelSlidesTimeline(page)).length, { timeout: 600_000 })
          .toBeGreaterThan(0);
        const slidesTimeline = await getPanelSlidesTimeline(page);
        const transcriptTimedText = await getPanelTranscriptTimedText(page);
        await expect
          .poll(async () => await getPanelSlidesSummaryComplete(page), { timeout: 600_000 })
          .toBe(true);
        await expect
          .poll(async () => (await getPanelSlidesSummaryMarkdown(page)).trim().length, {
            timeout: 600_000,
          })
          .toBeGreaterThan(0);
        const loadedSlideImages = page.locator(
          ".slideGallery__thumb img[data-loaded='true'], .slideStrip__thumb img[data-loaded='true'], .slideInline__thumb img[data-loaded='true']",
        );
        await expect
          .poll(async () => await loadedSlideImages.count(), { timeout: 600_000 })
          .toBeGreaterThan(0);
        const firstLoadedImage = await loadedSlideImages.first().evaluate((node) => {
          const img = node as HTMLImageElement;
          return {
            loaded: img.dataset.loaded ?? "",
            complete: img.complete,
            naturalWidth: img.naturalWidth,
            naturalHeight: img.naturalHeight,
            currentSrc: img.currentSrc,
          };
        });
        expect(firstLoadedImage.loaded).toBe("true");
        expect(firstLoadedImage.complete).toBe(true);
        expect(firstLoadedImage.naturalWidth).toBeGreaterThan(1);
        expect(firstLoadedImage.naturalHeight).toBeGreaterThan(1);
        expect(firstLoadedImage.currentSrc.length).toBeGreaterThan(0);
        const videoId = new URL(url).searchParams.get("v") ?? "youtube";
        await page.screenshot({
          path: testInfo.outputPath(`youtube-slides-${videoId}.png`),
          fullPage: true,
        });
        const slidesSummaryMarkdown = await getPanelSlidesSummaryMarkdown(page);
        const cliSummary = runCliSummary(url, [
          "--slides",
          "--slides-ocr",
          "--slides-max",
          String(SLIDES_MAX),
          "--json",
          "--length",
          length,
          "--language",
          "auto",
          "--model",
          "auto",
          "--video-mode",
          "transcript",
          "--timestamps",
        ]);
        const lengthArg = resolveSlidesLengthArg(length);
        const coercedSummary = coerceSummaryWithSlides({
          markdown: cliSummary,
          slides: slidesTimeline,
          transcriptTimedText: transcriptTimedText ?? null,
          lengthArg,
        });
        const expectedSlidesFromPanelSummary = parseSlidesFromSummary(
          coerceSummaryWithSlides({
            markdown: slidesSummaryMarkdown,
            slides: slidesTimeline,
            transcriptTimedText: transcriptTimedText ?? null,
            lengthArg,
          }),
        );
        if (process.env.SUMMARIZE_DEBUG_SLIDES === "1") {
          const panelSummary = await getPanelSummaryMarkdown(page);
          const slidesSummaryComplete = await getPanelSlidesSummaryComplete(page);
          const slidesSummaryModel = await getPanelSlidesSummaryModel(page);
          console.log("[slides-debug]", {
            url,
            panelSummaryLength: panelSummary.length,
            slidesSummaryLength: slidesSummaryMarkdown.length,
            slidesSummaryComplete,
            slidesSummaryModel,
          });
        }
        const expectedSlides = parseSlidesFromSummary(coercedSummary);
        expect(expectedSlides.length).toBeGreaterThan(0);
        expect(expectedSlidesFromPanelSummary.length).toBeGreaterThan(0);

        await expect
          .poll(async () => (await getPanelSlideDescriptions(page)).length, { timeout: 600_000 })
          .toBeGreaterThan(0);
        await page.evaluate(() => {
          const hooks = (
            window as typeof globalThis & {
              __summarizeTestHooks?: { forceRenderSlides?: () => number | void };
            }
          ).__summarizeTestHooks;
          hooks?.forceRenderSlides?.();
        });
        const panelSlides = (await getPanelSlideDescriptions(page))
          .map(([index, text]) => ({ index, text: normalizeWhitespace(text) }))
          .sort((a, b) => a.index - b.index);

        for (const slide of panelSlides) {
          expect(slide.text.length).toBeGreaterThan(0);
        }

        const panelIndexes = panelSlides.map((entry) => entry.index);
        const expectedIndexes = expectedSlides.map((entry) => entry.index);
        expect(panelIndexes).toEqual(expectedIndexes);
        const panelSummaryIndexes = expectedSlidesFromPanelSummary.map((entry) => entry.index);
        expect(panelIndexes).toEqual(panelSummaryIndexes);

        for (let i = 0; i < expectedSlides.length; i += 1) {
          const expected = expectedSlides[i];
          const actual = panelSlides[i];
          if (!expected || !actual) continue;
          if (!expected.text) continue;
          expect(actual.text.length).toBeGreaterThan(0);
          expect(overlapRatio(actual.text, expected.text)).toBeGreaterThanOrEqual(0.15);
        }
        for (let i = 0; i < expectedSlidesFromPanelSummary.length; i += 1) {
          const expected = expectedSlidesFromPanelSummary[i];
          const actual = panelSlides[i];
          if (!expected || !actual) continue;
          if (!expected.text) continue;
          expect(actual.text.length).toBeGreaterThan(0);
          expect(
            overlapRatio(actual.text, normalizeWhitespace(expected.text)),
          ).toBeGreaterThanOrEqual(0.4);
        }
      }

      assertNoErrors(harness);
    } finally {
      await closeExtension(harness.context, harness.userDataDir);
    }
  });
});
