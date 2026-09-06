import { expect, test } from "@playwright/test";
import {
  activateTabByUrl,
  closeExtension,
  getBackground,
  getBrowserFromProject,
  launchExtension,
  openExtensionPage,
  seedSettings,
  sendPanelMessage,
} from "./helpers/extension-harness";
import { getPanelModel, getPanelPhase, getPanelSummaryMarkdown } from "./helpers/panel-hooks";

const LIVE = process.env.SUMMARIZE_LIVE_BROWSER_MEDIA === "1";
const AUDIO_URL =
  "https://huggingface.co/datasets/Xenova/transformers.js-docs/resolve/main/jfk.wav";
const PAGE_URL = "https://summarize-media.example/";

test("transcribes public browser media through MediaBunny and local Whisper", async ({}, testInfo) => {
  test.skip(!LIVE, "Set SUMMARIZE_LIVE_BROWSER_MEDIA=1 to run local browser media transcription.");
  test.skip(testInfo.project.name !== "chromium", "Local browser Whisper is Chrome-only.");
  test.setTimeout(10 * 60 * 1000);

  const harness = await launchExtension(getBrowserFromProject(testInfo.project.name));
  try {
    const body = `<!doctype html><html><head><title>Speech fixture</title></head><body><audio controls preload="auto" src="${AUDIO_URL}"></audio></body></html>`;
    await harness.context.route(PAGE_URL, async (route) => {
      await route.fulfill({
        contentType: "text/html",
        body,
      });
    });
    await harness.context.route(AUDIO_URL, async (route) => {
      if (route.request().isNavigationRequest()) {
        await route.fulfill({ contentType: "text/html", body });
      } else {
        await route.continue();
      }
    });
    await seedSettings(harness, {
      token: "",
      autoSummarize: false,
      extendedLogging: true,
      slidesEnabled: false,
      slideRuntime: "browser",
      maxChars: 20_000,
    });
    const contentPage = await harness.context.newPage();
    await contentPage.goto(PAGE_URL, { waitUntil: "domcontentloaded" });
    await contentPage.waitForFunction(() => {
      const media = document.querySelector("audio");
      return Boolean(media && Number.isFinite(media.duration) && media.duration > 0);
    });
    const panel = await openExtensionPage(harness, "sidepanel.html", "#title");
    const background = await getBackground(harness);
    const readDiagnostics = async () =>
      await background.evaluate(async () => {
        const stored = await chrome.storage.session.get("summarize:extension-logs");
        const lines = Array.isArray(stored["summarize:extension-logs"])
          ? (stored["summarize:extension-logs"] as string[])
          : [];
        return lines
          .toReversed()
          .map((line) => {
            try {
              return JSON.parse(line) as Record<string, unknown>;
            } catch {
              return null;
            }
          })
          .filter(
            (entry) =>
              entry?.event === "extract:browser-media:transcript" ||
              entry?.event === "extract:browser-media:local-transcript-failed",
          );
      });

    for (const [source, url] of [
      ["embedded", PAGE_URL],
      ["direct", AUDIO_URL],
    ] as const) {
      const previousCount = (await readDiagnostics()).length;
      if (source === "direct") {
        await contentPage.goto(url, { waitUntil: "domcontentloaded" });
      }
      await activateTabByUrl(harness, url);
      await sendPanelMessage(panel, { type: "panel:summarize", refresh: true, inputMode: "video" });
      const deadline = Date.now() + 4 * 60 * 1000;
      let diagnostic: Record<string, unknown> | null | undefined;
      while (Date.now() < deadline) {
        const diagnostics = await readDiagnostics();
        diagnostic = diagnostics.length > previousCount ? diagnostics[0] : null;
        const phase = await getPanelPhase(panel);
        if (
          phase === "error" ||
          diagnostic?.event === "extract:browser-media:local-transcript-failed"
        ) {
          throw new Error(
            JSON.stringify({
              source,
              phase,
              status: await panel.locator("#subtitle").textContent(),
              diagnostic,
            }),
          );
        }
        if (diagnostic && (await getPanelModel(panel)) === "Browser") break;
        await panel.waitForTimeout(500);
      }
      expect(diagnostic).toMatchObject({
        event: "extract:browser-media:transcript",
        decoder: "mediabunny-webcodecs",
        mediaInput: "url-range",
        mediaSource: source,
      });
      expect(await getPanelModel(panel)).toBe("Browser");
      expect(await getPanelSummaryMarkdown(panel)).toMatch(/fellow Americans/i);
      expect(await getPanelSummaryMarkdown(panel)).toMatch(/country/i);
    }
  } finally {
    await closeExtension(harness.context, harness.userDataDir);
  }
});
