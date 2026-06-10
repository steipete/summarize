import { expect, test } from "@playwright/test";
import {
  assertNoErrors,
  closeExtension,
  getBrowserFromProject,
  getExtensionUrl,
  getOpenPickerList,
  getSettings,
  launchExtension,
  openExtensionPage,
  seedSettings,
  trackErrors,
} from "./helpers/extension-harness";
import { allowFirefoxExtensionTests } from "./helpers/extension-test-config";

test.skip(
  ({ browserName }) => browserName === "firefox" && !allowFirefoxExtensionTests,
  "Firefox extension tests are blocked by Playwright limitations. Set ALLOW_FIREFOX_EXTENSION_TESTS=1 to run.",
);

test("options pickers apply overlay selection", async ({ browserName: _browserName }, testInfo) => {
  const harness = await launchExtension(getBrowserFromProject(testInfo.project.name));

  try {
    const page = await openExtensionPage(harness, "options.html", "#tabs");
    await page.click("#tab-ui");
    await expect(page.locator("#panel-ui")).toBeVisible();

    const schemeLabel = page.locator("label.scheme");
    const schemeTrigger = schemeLabel.locator(".pickerTrigger");

    await schemeTrigger.focus();
    await schemeTrigger.press("Enter");
    const schemeList = getOpenPickerList(page);
    await expect(schemeList).toBeVisible();
    await schemeList.locator('[role="option"]').nth(2).click();

    await expect(schemeTrigger.locator(".scheme-label")).toHaveText("Mint");

    const modeLabel = page.locator("label.mode");
    const modeTrigger = modeLabel.locator(".pickerTrigger");

    await modeTrigger.focus();
    await modeTrigger.press("Enter");
    const modeList = getOpenPickerList(page);
    await expect(modeList).toBeVisible();
    await modeList.locator('[role="option"]').nth(1).click();

    await expect(modeTrigger).toHaveText("Light");
    assertNoErrors(harness);
  } finally {
    await closeExtension(harness.context, harness.userDataDir);
  }
});

test("options keeps custom model selected while presets refresh", async ({
  browserName: _browserName,
}, testInfo) => {
  const harness = await launchExtension(getBrowserFromProject(testInfo.project.name));

  try {
    await seedSettings(harness, { token: "test-token", model: "auto" });
    let modelCalls = 0;
    let releaseSecond: (() => void) | null = null;
    const secondGate = new Promise<void>((resolve) => {
      releaseSecond = resolve;
    });

    await harness.context.route("http://127.0.0.1:8787/v1/models", async (route) => {
      modelCalls += 1;
      if (modelCalls === 2) await secondGate;
      await route.fulfill({
        status: 200,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ok: true,
          options: [{ id: "auto", label: "" }],
          providers: { openrouter: true },
        }),
      });
    });
    await harness.context.route("http://127.0.0.1:8787/health", async (route) => {
      await route.fulfill({
        status: 200,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ok: true, version: "0.0.0" }),
      });
    });
    await harness.context.route("http://127.0.0.1:8787/v1/ping", async (route) => {
      await route.fulfill({
        status: 200,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ok: true }),
      });
    });

    const page = await openExtensionPage(harness, "options.html", "#tabs");
    await page.click("#tab-model");
    await expect(page.locator("#panel-model")).toBeVisible();
    await expect.poll(() => modelCalls).toBeGreaterThanOrEqual(1);
    await expect(page.locator("#modelPreset")).toHaveValue("auto");

    await page.evaluate(() => {
      const preset = document.getElementById("modelPreset") as HTMLSelectElement | null;
      if (!preset) return;
      preset.value = "custom";
      preset.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await expect(page.locator("#modelCustom")).toBeVisible();

    await page.locator("#modelCustom").focus();
    await expect.poll(() => modelCalls).toBe(2);
    releaseSecond?.();

    await expect(page.locator("#modelPreset")).toHaveValue("custom");
    await expect(page.locator("#modelCustom")).toBeVisible();
    assertNoErrors(harness);
  } finally {
    await closeExtension(harness.context, harness.userDataDir);
  }
});

test("options defers automation skills until Skills tab opens", async ({
  browserName: _browserName,
}, testInfo) => {
  const harness = await launchExtension(getBrowserFromProject(testInfo.project.name));

  try {
    const page = await openExtensionPage(harness, "options.html", "#tabs");
    await page.waitForLoadState("networkidle");

    await expect(page.locator("#panel-general")).toBeVisible();
    await expect(page.locator("#skillsList .skillCard")).toHaveCount(0);

    await page.click("#tab-skills");
    await expect(page.locator("#panel-skills")).toBeVisible();
    await expect
      .poll(async () => page.locator("#skillsList .skillCard").count())
      .toBeGreaterThan(0);
    assertNoErrors(harness);
  } finally {
    await closeExtension(harness.context, harness.userDataDir);
  }
});

test("options persists automation toggle without save", async ({
  browserName: _browserName,
}, testInfo) => {
  const harness = await launchExtension(getBrowserFromProject(testInfo.project.name));

  try {
    await seedSettings(harness, { automationEnabled: false });
    const page = await openExtensionPage(harness, "options.html", "#tabs");

    const toggle = page.locator("#automationToggle .checkboxRoot");
    await toggle.click();

    await expect
      .poll(async () => {
        const settings = await getSettings(harness);
        return settings.automationEnabled;
      })
      .toBe(true);

    await page.close();

    const reopened = await openExtensionPage(harness, "options.html", "#tabs");
    const checked = await reopened.evaluate(() => {
      const input = document.querySelector("#automationToggle input") as HTMLInputElement | null;
      return input?.checked ?? false;
    });
    expect(checked).toBe(true);
    assertNoErrors(harness);
  } finally {
    await closeExtension(harness.context, harness.userDataDir);
  }
});

test("options exposes runtime slide backend radios", async ({
  browserName: _browserName,
}, testInfo) => {
  const harness = await launchExtension(getBrowserFromProject(testInfo.project.name));

  try {
    await seedSettings(harness, { slideRuntime: "browser" });
    const page = await openExtensionPage(harness, "options.html", "#tabs");

    await expect(page.locator("#daemonStatus")).toContainText("Browser mode active");
    await expect(page.locator("#panel-general")).not.toContainText("Token");

    await page.click("#tab-runtime");
    await expect(page.locator("#panel-runtime")).toBeVisible();
    await expect(page.locator("#panel-runtime")).toContainText("Browser");
    await expect(page.locator("#panel-runtime")).toContainText("Daemon");
    await expect(page.locator("#panel-runtime")).toContainText("Browser cache");
    await expect(page.locator("#panel-runtime")).toContainText("Daemon token");
    await expect(page.locator("#panel-runtime")).not.toContainText("Show summary first");
    await expect(page.locator("#browserCacheStatus")).toContainText(/entries? · /);
    await page.locator("#browserCacheClear").click();
    await expect(page.locator("#browserCacheStatus")).toContainText("0 entries");

    const mode = page.locator("#slideRuntimeMode");
    await expect(mode.locator('input[value="browser"]')).toBeChecked();
    await mode.locator('input[value="daemon"]').click();
    await expect(page.locator("#daemonStatus")).toContainText("Add token to verify daemon");

    await expect
      .poll(async () => {
        const settings = await getSettings(harness);
        return settings.slideRuntime;
      })
      .toBe("daemon");

    await page.click("#tab-advanced");
    await expect(page.locator("#panel-advanced")).toContainText("Show summary first");

    assertNoErrors(harness);
  } finally {
    await closeExtension(harness.context, harness.userDataDir);
  }
});

test("options disables automation permissions button when granted", async ({
  browserName: _browserName,
}, testInfo) => {
  const harness = await launchExtension(getBrowserFromProject(testInfo.project.name));

  try {
    await seedSettings(harness, { automationEnabled: true });
    const page = await harness.context.newPage();
    trackErrors(page, harness.pageErrors, harness.consoleErrors);
    await page.addInitScript(() => {
      Object.defineProperty(chrome, "permissions", {
        configurable: true,
        value: {
          contains: async () => true,
          request: async () => true,
        },
      });
      Object.defineProperty(chrome, "userScripts", {
        configurable: true,
        value: {},
      });
    });
    await page.goto(getExtensionUrl(harness, "options.html"), {
      waitUntil: "domcontentloaded",
    });
    await page.waitForSelector("#tabs");

    await expect(page.locator("#automationPermissions")).toBeDisabled();
    await expect(page.locator("#automationPermissions")).toHaveText(
      "Automation permissions granted",
    );
    await expect(page.locator("#userScriptsNotice")).toBeHidden();
    assertNoErrors(harness);
  } finally {
    await closeExtension(harness.context, harness.userDataDir);
  }
});

test("options shows user scripts guidance when unavailable", async ({
  browserName: _browserName,
}, testInfo) => {
  const harness = await launchExtension(getBrowserFromProject(testInfo.project.name));

  try {
    await seedSettings(harness, { automationEnabled: true });
    const page = await harness.context.newPage();
    trackErrors(page, harness.pageErrors, harness.consoleErrors);
    await page.addInitScript(() => {
      Object.defineProperty(chrome, "permissions", {
        configurable: true,
        value: {
          contains: async () => false,
          request: async () => true,
        },
      });
      Object.defineProperty(chrome, "userScripts", {
        configurable: true,
        value: undefined,
      });
    });
    await page.goto(getExtensionUrl(harness, "options.html"), {
      waitUntil: "domcontentloaded",
    });
    await page.waitForSelector("#tabs");

    await expect(page.locator("#automationPermissions")).toBeEnabled();
    await expect(page.locator("#automationPermissions")).toHaveText(
      "Enable automation permissions",
    );
    await expect(page.locator("#userScriptsNotice")).toBeVisible();
    await expect(page.locator("#userScriptsNotice")).toContainText(/User Scripts|chrome:\/\//);
    assertNoErrors(harness);
  } finally {
    await closeExtension(harness.context, harness.userDataDir);
  }
});

test("options scheme list renders chips", async ({ browserName: _browserName }, testInfo) => {
  const harness = await launchExtension(getBrowserFromProject(testInfo.project.name));

  try {
    const page = await openExtensionPage(harness, "options.html", "#tabs");
    await page.click("#tab-ui");
    await expect(page.locator("#panel-ui")).toBeVisible();

    const schemeLabel = page.locator("label.scheme");
    const schemeTrigger = schemeLabel.locator(".pickerTrigger");

    await schemeTrigger.focus();
    await schemeTrigger.press("Enter");
    const schemeList = getOpenPickerList(page);
    await expect(schemeList).toBeVisible();

    const options = schemeList.locator(".pickerOption");
    await expect(options).toHaveCount(6);
    await expect(options.first().locator(".scheme-chips span")).toHaveCount(4);
    await expect(options.nth(1).locator(".scheme-chips span")).toHaveCount(4);

    assertNoErrors(harness);
  } finally {
    await closeExtension(harness.context, harness.userDataDir);
  }
});

test("options footer links to summarize site", async ({ browserName: _browserName }, testInfo) => {
  const harness = await launchExtension(getBrowserFromProject(testInfo.project.name));

  try {
    const page = await openExtensionPage(harness, "options.html", "#tabs");
    const summarizeLink = page.locator(".pageFooter a", { hasText: "Summarize" });
    await expect(summarizeLink).toHaveAttribute("href", /summarize\.sh/);
    assertNoErrors(harness);
  } finally {
    await closeExtension(harness.context, harness.userDataDir);
  }
});
