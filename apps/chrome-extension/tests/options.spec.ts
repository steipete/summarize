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
    await page.waitForFunction(() => document.documentElement.dataset.settingsReady === "true");

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

test("options exposes two AI connections and independent slide runtimes", async ({
  browserName: _browserName,
}, testInfo) => {
  const harness = await launchExtension(getBrowserFromProject(testInfo.project.name));

  try {
    await seedSettings(harness, { summaryRuntime: "direct", slideRuntime: "browser" });
    const page = await openExtensionPage(harness, "options.html", "#tabs");

    await expect(page.locator("#daemonStatus")).toContainText("Local companion not enabled");
    await expect(page.locator("#panel-general")).not.toContainText("Token");

    await page.click("#tab-runtime");
    await expect(page.locator("#panel-runtime")).toBeVisible();
    await expect(page.locator("#panel-runtime")).toContainText("Direct");
    await expect(page.locator("#panel-runtime")).toContainText("Daemon");
    await expect(page.locator("#summaryRuntimeMode .runtimeModeCard")).toHaveCount(2);
    await expect(page.locator("#panel-runtime")).not.toContainText("On-device");
    await page.click("#tab-advanced");
    await expect(page.locator("#modelPreset")).toContainText("Gemini Nano (on-device)");
    await page.click("#tab-runtime");
    await expect(page.locator("#panel-runtime")).toContainText("Browser cache");
    await expect(page.locator("#panel-runtime #daemonPort")).toBeVisible();
    await expect(page.locator("#panel-runtime #token")).toBeVisible();
    await expect(page.locator("#daemonPermissionEnable")).toBeVisible();
    await expect(page.locator("#panel-runtime")).not.toContainText("Show summary first");
    await expect(page.locator("#browserCacheStatus")).toContainText(/entries? · /);
    await page.locator("#browserCacheClear").click();
    await expect(page.locator("#browserCacheStatus")).toContainText("0 entries");

    const aiMode = page.locator("#summaryRuntimeMode");
    await expect(aiMode.locator('input[value="direct"]')).toBeChecked();
    const slideMode = page.locator("#slideRuntimeMode");
    await expect(slideMode.locator('input[value="browser"]')).toBeChecked();

    await page.click("#tab-advanced");
    await expect(page.locator("#panel-advanced")).toContainText("Show summary first");

    assertNoErrors(harness);
  } finally {
    await closeExtension(harness.context, harness.userDataDir);
  }
});

test("options stores an OpenAI key for direct mode without requiring the daemon", async ({
  browserName: _browserName,
}, testInfo) => {
  const harness = await launchExtension(getBrowserFromProject(testInfo.project.name));

  try {
    await seedSettings(harness, {
      summaryRuntime: "daemon",
      slideRuntime: "daemon",
      provider: "openrouter",
      providerApiKeys: {},
    });
    const page = await openExtensionPage(harness, "options.html", "#tabs");

    await expect(page.locator("#daemonStatus")).toContainText("Local companion not enabled");
    await page.click("#tab-runtime");
    await page.locator('#summaryRuntimeMode input[value="direct"]').click();
    await page.locator('#slideRuntimeMode input[value="browser"]').click();
    await expect
      .poll(async () => {
        const settings = await getSettings(harness);
        return { summaryRuntime: settings.summaryRuntime, slideRuntime: settings.slideRuntime };
      })
      .toEqual({ summaryRuntime: "direct", slideRuntime: "browser" });
    await page.locator("#provider").selectOption("openai");
    await expect.poll(async () => (await getSettings(harness)).provider).toBe("openai");
    await page.locator("#providerApiKey").fill("sk-test-direct-openai");

    await expect
      .poll(async () => {
        const settings = await getSettings(harness);
        return {
          summaryRuntime: settings.summaryRuntime,
          slideRuntime: settings.slideRuntime,
          provider: settings.provider,
          key: settings.providerApiKeys?.openai,
        };
      })
      .toEqual({
        summaryRuntime: "direct",
        slideRuntime: "browser",
        provider: "openai",
        key: "sk-test-direct-openai",
      });

    await page.reload();
    await page.click("#tab-runtime");
    await expect(page.locator('#summaryRuntimeMode input[value="direct"]')).toBeChecked();
    await expect(page.locator('#slideRuntimeMode input[value="browser"]')).toBeChecked();
    await expect(page.locator("#provider")).toHaveValue("openai");
    await expect(page.locator("#providerApiKey")).toHaveValue("sk-test-direct-openai");
    await expect(page.locator("#daemonStatus")).toContainText("Local companion not enabled");

    assertNoErrors(harness);
  } finally {
    await closeExtension(harness.context, harness.userDataDir);
  }
});

test("managed daemon disable locks the UI to Direct and Browser", async ({
  browserName: _browserName,
}, testInfo) => {
  const harness = await launchExtension(getBrowserFromProject(testInfo.project.name));

  try {
    await seedSettings(harness, {
      token: "saved-daemon-token",
      summaryRuntime: "daemon",
      slideRuntime: "daemon",
      autoCliFallback: true,
    });
    const page = await harness.context.newPage();
    trackErrors(page, harness.pageErrors, harness.consoleErrors);
    await page.addInitScript(() => {
      Object.defineProperty(chrome.storage, "managed", {
        configurable: true,
        value: {
          get: async () => ({ daemonAllowed: false }),
          setAccessLevel: async () => undefined,
        },
      });
    });
    await page.goto(getExtensionUrl(harness, "options.html"), { waitUntil: "domcontentloaded" });
    await page.waitForSelector("#tabs");

    await expect(page.locator("#daemonStatus")).toContainText("Disabled by administrator");
    await page.click("#tab-runtime");
    await expect(page.locator("#daemonCapabilityStatus")).toHaveText("Disabled by administrator");
    await expect(page.locator('#summaryRuntimeMode input[value="direct"]')).toBeChecked();
    await expect(page.locator('#slideRuntimeMode input[value="browser"]')).toBeChecked();
    await expect(page.locator('#summaryRuntimeMode input[value="daemon"]')).toBeDisabled();
    await expect(page.locator('#slideRuntimeMode input[value="daemon"]')).toBeDisabled();
    await expect(page.locator("#daemonPermissionEnable")).toBeHidden();
    await expect(page.locator("#token")).toBeDisabled();
    await expect(page.locator("#token")).toHaveValue("");
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

test("options persists direct provider credentials per provider", async ({
  browserName: _browserName,
}, testInfo) => {
  const harness = await launchExtension(getBrowserFromProject(testInfo.project.name));

  try {
    await seedSettings(harness, {
      summaryRuntime: "direct",
      provider: "openai",
      providerApiKeys: { openai: "openai-key" },
      providerBaseUrls: {},
    });
    const page = await openExtensionPage(harness, "options.html", "#tabs");
    await page.click("#tab-runtime");
    await expect(page.locator("#provider")).toHaveValue("openai");
    await expect(page.locator("#providerApiKey")).toHaveValue("openai-key");

    await page.locator("#provider").selectOption("anthropic");
    await expect(page.locator("#providerApiKey")).toHaveValue("");
    await expect(page.locator("#providerBaseUrl")).toHaveValue("");
    await page.locator("#providerApiKey").fill("anthropic-key");
    await page.locator("#providerBaseUrl").fill("https://anthropic.test");

    await expect
      .poll(async () => {
        const settings = await getSettings(harness);
        return (settings.providerApiKeys as Record<string, string> | undefined)?.anthropic;
      })
      .toBe("anthropic-key");

    await page.locator("#provider").selectOption("openai");
    await expect(page.locator("#providerApiKey")).toHaveValue("openai-key");
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

test("options persists a custom daemon port", async ({ browserName: _browserName }, testInfo) => {
  const harness = await launchExtension(getBrowserFromProject(testInfo.project.name));

  try {
    await seedSettings(harness, { daemonPort: "9931" });
    const page = await openExtensionPage(harness, "options.html", "#tabs");
    await page.click("#tab-runtime");
    await expect(page.locator("#daemonPort")).toHaveValue("9931");
    await page.locator("#daemonPort").fill("8788");
    await expect
      .poll(async () => {
        const settings = await getSettings(harness);
        return settings.daemonPort;
      })
      .toBe("8788");
    await page.locator("#daemonPort").fill("65536");
    await expect(page.locator("#daemonPort")).toHaveValue("8787");
    await expect.poll(async () => (await getSettings(harness)).daemonPort).toBe("8787");
    assertNoErrors(harness);
  } finally {
    await closeExtension(harness.context, harness.userDataDir);
  }
});
