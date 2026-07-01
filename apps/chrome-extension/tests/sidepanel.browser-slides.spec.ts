import fs from "node:fs";
import { createServer as createHttpServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { createSampleVideo, hasFfmpeg } from "./helpers/daemon-fixtures";
import {
  activateTabByUrl,
  assertNoErrors,
  buildUiState,
  closeExtension,
  getActiveTabId,
  getBackground,
  getBrowserFromProject,
  launchExtension,
  openExtensionPage,
  seedSettings,
  sendBgMessage,
  sendPanelMessage,
  waitForActiveTabUrl,
  waitForPanelPort,
} from "./helpers/extension-harness";
import { getPanelSlidesTimeline, waitForSettingsHydratedHook } from "./helpers/panel-hooks";

test("sidepanel captures local video slides in browser runtime", async ({
  browserName: _browserName,
}, testInfo) => {
  test.setTimeout(90_000);

  if (testInfo.project.name === "firefox") {
    test.skip(true, "Browser slide capture is validated in Chromium.");
  }
  test.skip(!hasFfmpeg(), "FFmpeg is required to generate the H.264 browser fixture.");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "summarize-browser-slides-"));
  const videoPath = path.join(tmpDir, "sample.mp4");
  createSampleVideo(videoPath);

  const html = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>Browser Slides Test</title>
    <style>
      body { margin: 0; padding: 32px; background: #f7f7f7; font-family: sans-serif; }
      video { display: block; width: 640px; height: 360px; background: black; }
    </style>
  </head>
  <body>
    <h1>Browser Slides Test</h1>
    <video controls width="640" height="360" preload="auto" muted>
      <source src="/sample.mp4" type="video/mp4" />
    </video>
  </body>
</html>`;

  const server = createHttpServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/" || url.pathname === "/index.html") {
      const body = Buffer.from(html, "utf8");
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "content-length": body.length,
      });
      res.end(body);
      return;
    }
    if (url.pathname === "/sample.mp4") {
      const body = fs.readFileSync(videoPath);
      res.writeHead(200, {
        "content-type": "video/mp4",
        "content-length": body.length,
      });
      res.end(body);
      return;
    }
    res.writeHead(204);
    res.end();
  });

  let serverUrl = "";
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Failed to resolve local server port"));
        return;
      }
      serverUrl = `http://localhost:${address.port}`;
      resolve();
    });
  });

  const harness = await launchExtension(getBrowserFromProject(testInfo.project.name));

  try {
    await seedSettings(harness, {
      token: "",
      autoSummarize: false,
      slidesEnabled: true,
      slidesParallel: true,
    });

    const contentPage = await harness.context.newPage();
    await contentPage.goto(`${serverUrl}/index.html`, { waitUntil: "domcontentloaded" });
    await contentPage.waitForFunction(() => {
      const video = document.querySelector("video");
      return Boolean(video && Number.isFinite(video.duration) && video.duration > 0);
    });
    await activateTabByUrl(harness, serverUrl);
    await waitForActiveTabUrl(harness, serverUrl);
    const activeTabId = await getActiveTabId(harness);

    const panel = await openExtensionPage(harness, "sidepanel.html", "#title");
    await waitForPanelPort(panel);
    await waitForSettingsHydratedHook(panel);

    await activateTabByUrl(harness, serverUrl);
    await waitForActiveTabUrl(harness, serverUrl);
    const initialVideoState = await contentPage.evaluate(async () => {
      const video = document.querySelector("video");
      if (!(video instanceof HTMLVideoElement)) throw new Error("Missing video element");
      video.muted = true;
      await video.play();
      const startedAt = Date.now();
      while (video.currentTime < 1 && Date.now() - startedAt < 2500) {
        await new Promise((resolve) => window.setTimeout(resolve, 50));
      }
      return { paused: video.paused, currentTime: video.currentTime };
    });
    expect(initialVideoState.paused).toBe(false);
    expect(initialVideoState.currentTime).toBeGreaterThan(0.75);
    const background = await getBackground(harness);
    const activeVideoState = await background.evaluate(async () => {
      const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      if (!tab?.id) return null;
      const [result] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        world: "MAIN",
        func: () => {
          const video = document.querySelector("video");
          return video instanceof HTMLVideoElement
            ? { paused: video.paused, currentTime: video.currentTime }
            : null;
        },
      });
      return { tabId: tab.id, url: tab.url, video: result.result };
    });
    expect(activeVideoState?.video?.currentTime ?? -1).toBeGreaterThan(0.75);
    await sendBgMessage(harness, {
      type: "ui:state",
      state: buildUiState({
        daemon: { ok: false, authed: false, error: "daemon unavailable" },
        tab: { id: activeTabId, url: `${serverUrl}/index.html`, title: "Browser Slides Test" },
        media: { hasVideo: true, hasAudio: false, hasCaptions: false },
        stats: { pageWords: 3, videoDurationSeconds: 6 },
        settings: {
          autoSummarize: false,
          slidesEnabled: true,
          slidesParallel: true,
          tokenPresent: false,
        },
      }),
    });

    await sendPanelMessage(panel, { type: "panel:summarize", refresh: true, inputMode: "video" });

    await expect
      .poll(
        async () =>
          await background.evaluate(() =>
            JSON.stringify(globalThis.__summarizeBrowserSlidesLastResult ?? null),
          ),
        { timeout: 120_000 },
      )
      .not.toBe("null");
    const browserSlidesResult = await background.evaluate(
      () => globalThis.__summarizeBrowserSlidesLastResult,
    );
    if (
      !browserSlidesResult ||
      typeof browserSlidesResult !== "object" ||
      (browserSlidesResult as { ok?: unknown }).ok !== true
    ) {
      throw new Error(`Browser slides failed: ${JSON.stringify(browserSlidesResult)}`);
    }
    const slideSourceKind = (browserSlidesResult as { slides?: { sourceKind?: string } }).slides
      ?.sourceKind;
    if (slideSourceKind !== "browser-mediabunny") {
      const fallback = await background.evaluate(
        () => globalThis.__summarizeBrowserMediaFallback ?? null,
      );
      throw new Error(`Expected MediaBunny slides, got ${slideSourceKind}: ${fallback}`);
    }

    await expect
      .poll(async () => (await getPanelSlidesTimeline(panel)).length, { timeout: 120_000 })
      .toBeGreaterThan(0);
    await expect
      .poll(
        async () =>
          await panel.evaluate(
            () =>
              Array.from(
                document.querySelectorAll<HTMLImageElement>("img[data-slide-image-url]"),
              ).filter((img) => img.dataset.slideImageUrl?.startsWith("data:image/")).length,
          ),
        { timeout: 10_000 },
      )
      .toBeGreaterThan(0);
    const restoredVideoState = await contentPage.evaluate(() => {
      const video = document.querySelector("video");
      if (!(video instanceof HTMLVideoElement)) return null;
      return { paused: video.paused, currentTime: video.currentTime };
    });
    if (restoredVideoState?.paused !== false) {
      throw new Error(
        `Video was not restored: ${JSON.stringify({
          initialVideoState,
          restoredVideoState,
        })}`,
      );
    }

    assertNoErrors(harness);
  } finally {
    await closeExtension(harness.context, harness.userDataDir);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
