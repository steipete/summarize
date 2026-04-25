import fs from "node:fs";
import { createServer as createHttpServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { runDaemonServer } from "../../../src/daemon/server.js";
import { META_SITE_EXCLUDE_MATCHES } from "../src/lib/content-script-matches";
import {
  BLOCKED_ENV_KEYS,
  DAEMON_PORT,
  DEFAULT_DAEMON_TOKEN,
  SLIDES_MAX,
  createSampleVideo,
  getSummarizeBodies,
  getSummarizeCalls,
  getSummarizeCallTimes,
  getSummarizeLastBody,
  hasFfmpeg,
  hasYtDlp,
  isPortInUse,
  mockDaemonSummarize,
  normalizeWhitespace,
  overlapRatio,
  parseSlidesFromSummary,
  readDaemonToken,
  resolveSlidesLengthArg,
  runCliSummary,
  startDaemonSlidesRun,
  startDaemonSummaryRun,
  waitForSlidesSnapshot,
} from "./helpers/daemon-fixtures";
import {
  activateTabByUrl,
  assertNoErrors,
  buildAgentStream,
  buildUiState,
  closeExtension,
  getActiveTabId,
  getActiveTabUrl,
  getBackground,
  getBrowserFromProject,
  getSettings,
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
  type ExtensionHarness,
} from "./helpers/extension-harness";
import { allowFirefoxExtensionTests } from "./helpers/extension-test-config";
import { getPanelModel, getPanelPhase } from "./helpers/panel-hooks";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

test.skip(
  ({ browserName }) => browserName === "firefox" && !allowFirefoxExtensionTests,
  "Firefox extension tests are blocked by Playwright limitations. Set ALLOW_FIREFOX_EXTENSION_TESTS=1 to run.",
);

test("manifest excludes Meta sites from always-on content scripts", () => {
  const manifestPath = path.resolve(__dirname, "..", ".output", "chrome-mv3", "manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
    content_scripts?: Array<{ js?: string[]; exclude_matches?: string[] }>;
  };
  const contentScripts = manifest.content_scripts ?? [];
  const alwaysOnScripts = new Set([
    "content-scripts/automation.js",
    "content-scripts/extract.js",
    "content-scripts/hover.js",
  ]);
  const matchingEntries = contentScripts.filter((entry) =>
    entry.js?.some((script) => alwaysOnScripts.has(script)),
  );

  expect(matchingEntries.length).toBeGreaterThan(0);
  for (const entry of matchingEntries) {
    expect(entry.exclude_matches ?? []).toEqual(expect.arrayContaining(META_SITE_EXCLUDE_MATCHES));
  }
});

test("sidepanel shows a ready state instead of going blank when switching tabs manually", async ({
  browserName: _browserName,
}, testInfo) => {
  const harness = await launchExtension(getBrowserFromProject(testInfo.project.name));

  try {
    await seedSettings(harness, {
      token: "test-token",
      autoSummarize: false,
      slidesEnabled: false,
    });
    const page = await openExtensionPage(harness, "sidepanel.html", "#title");
    await waitForPanelPort(page);

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

    await sendBgMessage(harness, {
      type: "ui:state",
      state: buildUiState({
        tab: { id: 1, url: "https://www.youtube.com/watch?v=alpha123", title: "Alpha Tab" },
        settings: { autoSummarize: false, tokenPresent: true, slidesEnabled: false },
        status: "",
      }),
    });
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
    await expect(page.locator("#render")).toContainText("Summary A");

    await sendBgMessage(harness, {
      type: "ui:state",
      state: buildUiState({
        tab: { id: 2, url: "https://www.youtube.com/watch?v=bravo456", title: "Bravo Tab" },
        settings: { autoSummarize: false, tokenPresent: true, slidesEnabled: false },
        status: "",
      }),
    });

    await expect(page.locator("#render")).toContainText("Click Summarize to start.");
    await expect(page.locator("#render")).toContainText("Bravo Tab");
    await expect(page.locator("#render")).not.toContainText("Summary A");

    assertNoErrors(harness);
  } finally {
    await closeExtension(harness.context, harness.userDataDir);
  }
});

test("sidepanel shows a loading state instead of going blank while waiting for auto summarize", async ({
  browserName: _browserName,
}, testInfo) => {
  const harness = await launchExtension(getBrowserFromProject(testInfo.project.name));

  try {
    await seedSettings(harness, { token: "test-token", autoSummarize: true, slidesEnabled: false });
    const page = await openExtensionPage(harness, "sidepanel.html", "#title");
    await waitForPanelPort(page);

    await sendBgMessage(harness, {
      type: "ui:state",
      state: buildUiState({
        tab: { id: 2, url: "https://www.youtube.com/watch?v=bravo456", title: "Bravo Tab" },
        settings: { autoSummarize: true, tokenPresent: true, slidesEnabled: false },
        status: "",
      }),
    });

    await expect(page.locator("#render")).toContainText("Preparing summary");
    await expect(page.locator(".renderEmpty__label")).toHaveText("Loading");

    assertNoErrors(harness);
  } finally {
    await closeExtension(harness.context, harness.userDataDir);
  }
});

test("sidepanel resumes a pending summary run when returning to the original tab", async ({
  browserName: _browserName,
}, testInfo) => {
  const harness = await launchExtension(getBrowserFromProject(testInfo.project.name));

  try {
    await seedSettings(harness, {
      token: "test-token",
      autoSummarize: false,
      slidesEnabled: false,
    });
    const page = await openExtensionPage(harness, "sidepanel.html", "#title");
    await waitForPanelPort(page);

    const sseBody = [
      "event: chunk",
      `data: ${JSON.stringify({ text: "Summary A" })}`,
      "",
      "event: done",
      "data: {}",
      "",
    ].join("\n");
    await page.route("http://127.0.0.1:8787/v1/summarize/run-a/events", async (route) => {
      await route.fulfill({
        status: 200,
        headers: { "content-type": "text/event-stream" },
        body: sseBody,
      });
    });

    const tabAState = buildUiState({
      tab: { id: 1, url: "https://www.youtube.com/watch?v=alpha123", title: "Alpha Tab" },
      settings: { autoSummarize: false, tokenPresent: true, slidesEnabled: false },
      status: "",
    });
    const tabBState = buildUiState({
      tab: { id: 2, url: "https://www.youtube.com/watch?v=bravo456", title: "Bravo Tab" },
      settings: { autoSummarize: false, tokenPresent: true, slidesEnabled: false },
      status: "",
    });

    await sendBgMessage(harness, { type: "ui:state", state: tabAState });
    await sendBgMessage(harness, { type: "ui:state", state: tabBState });
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

    await expect(page.locator("#render")).toContainText("Click Summarize to start.");
    await expect(page.locator("#render")).toContainText("Bravo Tab");
    await expect(page.locator("#render")).not.toContainText("Summary A");

    await sendBgMessage(harness, { type: "ui:state", state: tabAState });
    await expect(page.locator("#render")).toContainText("Summary A");

    assertNoErrors(harness);
  } finally {
    await closeExtension(harness.context, harness.userDataDir);
  }
});

test("sidepanel switches between page, video, and slides modes", async ({
  browserName: _browserName,
}, testInfo) => {
  const harness = await launchExtension(getBrowserFromProject(testInfo.project.name));

  try {
    await seedSettings(harness, {
      token: "test-token",
      autoSummarize: false,
      slidesEnabled: false,
      slidesLayout: "gallery",
      slidesOcrEnabled: true,
    });
    const page = await openExtensionPage(harness, "sidepanel.html", "#title");
    await waitForPanelPort(page);
    await page.evaluate(() => {
      const global = window as typeof globalThis & {
        __summarizePanelPort?: { disconnect?: () => void } | undefined;
      };
      global.__summarizePanelPort?.disconnect?.();
      global.__summarizePanelPort = undefined;
    });

    await page.route("http://127.0.0.1:8787/v1/tools", async (route) => {
      await route.fulfill({
        status: 200,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ok: true,
          tools: {
            ytDlp: { available: true },
            ffmpeg: { available: true },
            tesseract: { available: true },
          },
        }),
      });
    });

    const sseBody = (text: string) =>
      ["event: chunk", `data: ${JSON.stringify({ text })}`, "", "event: done", "data: {}", ""].join(
        "\n",
      );
    await page.route("http://127.0.0.1:8787/v1/summarize/**/events", async (route) => {
      const url = route.request().url();
      const match = url.match(/summarize\/([^/]+)\/events/);
      const runId = match ? (match[1] ?? "") : "";
      const text =
        runId === "run-page"
          ? "Page summary"
          : runId === "run-video"
            ? "Video summary"
            : runId === "run-slides"
              ? "Slides summary"
              : "Back summary";
      await route.fulfill({
        status: 200,
        headers: { "content-type": "text/event-stream" },
        body: sseBody(text),
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
      tab: { id: 1, url: "https://example.com/video", title: "Example Video" },
      media: { hasVideo: true, hasAudio: true, hasCaptions: false },
      stats: { pageWords: 120, videoDurationSeconds: 120 },
      settings: {
        autoSummarize: false,
        slidesEnabled: false,
        slidesParallel: true,
        slidesLayout: "gallery",
        slidesOcrEnabled: true,
        tokenPresent: true,
      },
      status: "",
    });
    const summarizeButton = page.locator(".summarizeButton");
    await expect(summarizeButton).toBeVisible();

    await page.waitForFunction(
      () => {
        const hooks = (
          window as typeof globalThis & {
            __summarizeTestHooks?: {
              setSummarizeMode?: unknown;
              applyUiState?: unknown;
            };
          }
        ).__summarizeTestHooks;
        return (
          typeof hooks?.setSummarizeMode === "function" && typeof hooks?.applyUiState === "function"
        );
      },
      null,
      { timeout: 5_000 },
    );

    const setSummarizeMode = async (mode: "page" | "video", slides: boolean) => {
      await page.evaluate(
        async (payload) => {
          const hooks = (
            window as typeof globalThis & {
              __summarizeTestHooks?: {
                setSummarizeMode?: (payload: {
                  mode: "page" | "video";
                  slides: boolean;
                }) => Promise<void>;
                getSummarizeMode?: () => {
                  mode: "page" | "video";
                  slides: boolean;
                  mediaAvailable: boolean;
                };
              };
            }
          ).__summarizeTestHooks;
          await hooks?.setSummarizeMode?.(payload);
        },
        { mode, slides },
      );
    };

    const getSummarizeMode = async () =>
      await page.evaluate(() => {
        const hooks = (
          window as typeof globalThis & {
            __summarizeTestHooks?: {
              getSummarizeMode?: () => {
                mode: "page" | "video";
                slides: boolean;
                mediaAvailable: boolean;
              };
            };
          }
        ).__summarizeTestHooks;
        return hooks?.getSummarizeMode?.() ?? null;
      });

    const expectSummarizeMode = async (mode: "page" | "video", slides: boolean) => {
      await expect
        .poll(async () => {
          const current = await getSummarizeMode();
          return current ? { mode: current.mode, slides: current.slides } : null;
        })
        .toEqual({ mode, slides });
    };

    const applyUiState = async (state: UiState) => {
      await page.evaluate((payload) => {
        const hooks = (
          window as typeof globalThis & {
            __summarizeTestHooks?: { applyUiState?: (state: UiState) => void };
          }
        ).__summarizeTestHooks;
        hooks?.applyUiState?.(payload);
      }, state);
    };

    const ensureMediaAvailable = async (slidesEnabled: boolean) => {
      const state = buildUiState({
        ...uiState,
        settings: { ...uiState.settings, slidesEnabled },
      });
      await applyUiState(state);
      await expect.poll(async () => (await getSummarizeMode())?.mediaAvailable ?? false).toBe(true);
    };

    await ensureMediaAvailable(false);
    await expect(summarizeButton).toHaveAttribute("aria-label", /Page(?: · 120 words)?/);

    await setSummarizeMode("page", false);
    await expectSummarizeMode("page", false);
    await expect(summarizeButton).toHaveAttribute("aria-label", /Page/);
    await expect(
      page.locator("img.slideStrip__thumbImage, img.slideInline__thumbImage"),
    ).toHaveCount(0);

    await ensureMediaAvailable(false);
    await setSummarizeMode("video", false);
    await expectSummarizeMode("video", false);
    await expect(summarizeButton).toHaveAttribute("aria-label", /Video/);
    await expect(
      page.locator("img.slideStrip__thumbImage, img.slideInline__thumbImage"),
    ).toHaveCount(0);

    await ensureMediaAvailable(true);
    await setSummarizeMode("video", true);
    await expectSummarizeMode("video", true);
    await expect.poll(async () => (await getSummarizeMode())?.slides ?? false).toBe(true);
    await expect(summarizeButton).toHaveAttribute("aria-label", /Slides/);

    await ensureMediaAvailable(false);
    await setSummarizeMode("page", false);
    await expectSummarizeMode("page", false);
    await expect(summarizeButton).toHaveAttribute("aria-label", /Page/);
    await sendBgMessage(harness, {
      type: "run:start",
      run: {
        id: "run-back",
        url: "https://example.com/video",
        title: "Example Video",
        model: "auto",
        reason: "manual",
      },
    });
    await expect(
      page.locator("img.slideStrip__thumbImage, img.slideInline__thumbImage"),
    ).toHaveCount(0);

    assertNoErrors(harness);
  } finally {
    await closeExtension(harness.context, harness.userDataDir);
  }
});

test("sidepanel auto summarize toggle stays inline", async ({
  browserName: _browserName,
}, testInfo) => {
  const harness = await launchExtension(getBrowserFromProject(testInfo.project.name));

  try {
    await seedSettings(harness, { token: "test-token" });
    await harness.context.route("http://127.0.0.1:8787/v1/models", async (route) => {
      await route.fulfill({
        status: 200,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ok: true,
          options: [],
          providers: {},
          localModelsSource: null,
        }),
      });
    });
    const page = await openExtensionPage(harness, "sidepanel.html", "#title");
    await page.click("#drawerToggle");
    await expect(page.locator("#drawer")).toBeVisible();
    await page.click("#advancedSettings > summary");
    await expect(page.locator("#advancedSettings")).toHaveJSProperty("open", true);

    const label = page.locator("#autoToggle .checkboxRoot");
    await expect(label).toBeVisible();
    const labelBox = await label.boundingBox();
    const controlBox = await page.locator("#autoToggle .checkboxControl").boundingBox();
    const textBox = await page.locator("#autoToggle .checkboxLabel").boundingBox();

    expect(labelBox).not.toBeNull();
    expect(controlBox).not.toBeNull();
    expect(textBox).not.toBeNull();

    if (labelBox && controlBox && textBox) {
      expect(controlBox.y).toBeGreaterThanOrEqual(labelBox.y - 1);
      expect(controlBox.y).toBeLessThanOrEqual(labelBox.y + labelBox.height - 1);
      expect(textBox.y).toBeGreaterThanOrEqual(labelBox.y - 1);
      expect(textBox.y).toBeLessThanOrEqual(labelBox.y + labelBox.height - 1);
    }

    assertNoErrors(harness);
  } finally {
    await closeExtension(harness.context, harness.userDataDir);
  }
});
