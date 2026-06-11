import { expect, test } from "@playwright/test";
import {
  activateTabByUrl,
  closeExtension,
  getBrowserFromProject,
  launchExtension,
  openExtensionPage,
  seedSettings,
  sendPanelMessage,
} from "./helpers/extension-harness";
import { getPanelModel, getPanelPhase, getPanelSummaryMarkdown } from "./helpers/panel-hooks";

const LIVE = process.env.SUMMARIZE_LIVE_TESTS === "1";
const VIDEO_ID = process.env.SUMMARIZE_LIVE_YOUTUBE_NO_CAPTIONS_ID ?? "XJ1SaNX4s8I";

test("transcribes a captionless YouTube video through the extension runtime", async ({}, testInfo) => {
  test.skip(!LIVE, "Set SUMMARIZE_LIVE_TESTS=1 to run live YouTube transcription.");
  test.skip(testInfo.project.name !== "chromium", "Daemonless local Whisper is Chrome-only.");
  test.setTimeout(300_000);

  const harness = await launchExtension(getBrowserFromProject(testInfo.project.name));
  const consoleMessages: string[] = [];
  harness.context.on("console", (message) => {
    consoleMessages.push(`[${message.type()}] ${message.text()}`);
  });
  try {
    await seedSettings(harness, {
      token: "",
      autoSummarize: false,
      extendedLogging: true,
      slidesEnabled: false,
      slideRuntime: "browser",
      maxChars: 20_000,
    });
    const videoUrl = `https://www.youtube.com/watch?v=${VIDEO_ID}`;
    const videoPage = await harness.context.newPage();
    await videoPage.goto(videoUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await videoPage.waitForFunction(() => Boolean(document.querySelector("#movie_player")), null, {
      timeout: 30_000,
    });
    const playerState = await videoPage.evaluate(() => {
      const player = document.querySelector("#movie_player") as
        | (Element & { getPlayerResponse?: () => unknown })
        | null;
      const response = player?.getPlayerResponse?.() as
        | {
            captions?: {
              playerCaptionsTracklistRenderer?: { captionTracks?: unknown[] };
            };
            videoDetails?: { videoId?: string };
          }
        | undefined;
      return {
        videoId: response?.videoDetails?.videoId ?? null,
        captionTrackCount:
          response?.captions?.playerCaptionsTracklistRenderer?.captionTracks?.length ?? 0,
      };
    });

    const panel = await openExtensionPage(harness, "sidepanel.html", "#title");
    await activateTabByUrl(harness, videoUrl);

    await sendPanelMessage(panel, {
      type: "panel:summarize",
      refresh: true,
      inputMode: "video",
    });
    const panelTransitions: string[] = [];
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      const state = {
        model: await getPanelModel(panel),
        phase: await getPanelPhase(panel),
        status: await panel.locator("#subtitle").textContent(),
        summaryLength: (await getPanelSummaryMarkdown(panel)).length,
      };
      const serialized = JSON.stringify(state);
      if (panelTransitions.at(-1) !== serialized) panelTransitions.push(serialized);
      if (state.model === "Browser") break;
      await panel.waitForTimeout(500);
    }
    if ((await getPanelModel(panel)) !== "Browser") {
      throw new Error(
        [
          "Sidepanel did not finish the browser summary.",
          `player=${JSON.stringify(playerState)}`,
          `transitions=${JSON.stringify(panelTransitions)}`,
          `console=${JSON.stringify(consoleMessages.slice(-50))}`,
        ].join("\n"),
      );
    }
    const summary = await getPanelSummaryMarkdown(panel);
    expect(playerState.captionTrackCount).toBe(0);
    expect(summary.length).toBeGreaterThan(500);
    expect(summary).not.toContain("No transcript text was available from the browser");
    expect(
      consoleMessages.some((message) => message.includes("extract:url-direct:local-transcript")),
    ).toBe(true);
  } finally {
    await closeExtension(harness.context, harness.userDataDir);
  }
});
