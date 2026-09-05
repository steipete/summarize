import { expect } from "@playwright/test";
import { test } from "./helpers/extension-fixtures";
import {
  getExtensionUrl,
  getOpenPickerList,
  getSettings,
  openExtensionPage,
  seedSettings,
  trackErrors,
} from "./helpers/extension-harness";

test("options checkbox controllers persist only their own setting", async ({ harness }) => {
  const page = await openExtensionPage(harness, "options.html", "#tabs");
  await expect(page.locator("html")).toHaveAttribute("data-settings-ready", "true");
  const toggles = [
    ["autoSummarize", "options-auto"],
    ["chatEnabled", "options-chat"],
    ["automationEnabled", "options-automation"],
    ["hoverSummaries", "options-hover-summaries"],
    ["summaryTimestamps", "options-summary-timestamps"],
    ["slidesParallel", "options-slides-parallel"],
    ["slidesOcrEnabled", "options-slides-ocr"],
    ["extendedLogging", "options-extended-logging"],
    ["autoCliFallback", "options-auto-cli-fallback"],
  ] as const;
  const expected = Object.fromEntries(
    await Promise.all(
      toggles.map(async ([key, id]) => [key, await page.locator(`#${id}`).isChecked()]),
    ),
  );
  for (const [key, id] of toggles) {
    const input = page.locator(`#${id}`);
    const tab = await input.evaluate((element) =>
      element.closest("[data-tab-panel]")?.getAttribute("data-tab-panel"),
    );
    await page.click(`#tab-${tab}`);
    expected[key] = !(await input.isChecked());
    await input.setChecked(expected[key], { force: true });
    await expect
      .poll(async () => {
        const saved = await getSettings(harness);
        return Object.fromEntries(toggles.map(([setting]) => [setting, saved[setting]]));
      })
      .toEqual(expected);
  }
});

test("options saves preserve a dismissed companion hint", async ({ harness }) => {
  await seedSettings(harness, { daemonHintDismissed: true, autoSummarize: true });
  const page = await openExtensionPage(harness, "options.html", "#tabs");
  await expect(page.locator("html")).toHaveAttribute("data-settings-ready", "true");
  await page.locator("#options-auto").setChecked(false, { force: true });
  await expect
    .poll(async () => await getSettings(harness))
    .toMatchObject({ autoSummarize: false, daemonHintDismissed: true });
});

test("options pickers apply overlay selection", async ({ harness }) => {
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
});

test("options restores the active tab from browser local storage", async ({ harness }) => {
  const page = await openExtensionPage(harness, "options.html", "#tabs");
  await page.click("#tab-runtime");
  await expect(page.locator("#panel-runtime")).toBeVisible();

  await page.reload();
  await expect(page.locator("#tab-runtime")).toHaveAttribute("aria-selected", "true");
  await expect(page.locator("#panel-runtime")).toBeVisible();
});

test("options restores the Logs tab without aborting startup", async ({ harness }) => {
  const page = await openExtensionPage(harness, "options.html", "#tabs");
  await page.click("#tab-logs");
  await expect(page.locator("#panel-logs")).toBeVisible();

  await page.reload();
  await expect(page.locator("#tab-logs")).toHaveAttribute("aria-selected", "true");
  await expect(page.locator("#panel-logs")).toBeVisible();
});

test("options themes password and URL fields like the provider control", async ({ harness }) => {
  await seedSettings(harness, {
    colorMode: "dark",
    colorScheme: "slate",
    provider: "openai",
    summaryRuntime: "daemon",
  });
  const page = await openExtensionPage(harness, "options.html", "#tabs");
  await page.click("#tab-runtime");
  await expect(page.locator("#panel-runtime")).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("data-mode", "dark");

  const readControlStyle = (selector: string) =>
    page.locator(selector).evaluate((element) => {
      const style = getComputedStyle(element);
      return {
        backgroundColor: style.backgroundColor,
        borderColor: style.borderColor,
        borderRadius: style.borderRadius,
        borderStyle: style.borderStyle,
        borderWidth: style.borderWidth,
        color: style.color,
        fontFamily: style.fontFamily,
        fontSize: style.fontSize,
      };
    });

  const [providerStyle, apiKeyStyle, baseUrlStyle] = await Promise.all([
    readControlStyle("#provider"),
    readControlStyle("#providerApiKey"),
    readControlStyle("#providerBaseUrl"),
  ]);

  expect(apiKeyStyle).toEqual(providerStyle);
  expect(baseUrlStyle).toEqual(providerStyle);
});

test("options keeps custom model selected while presets refresh", async ({ harness }) => {
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
});

test("options defers automation skills until Skills tab opens", async ({ harness }) => {
  const page = await openExtensionPage(harness, "options.html", "#tabs");
  await page.waitForLoadState("networkidle");

  await expect(page.locator("#panel-general")).toBeVisible();
  await expect(page.locator("#skillsList .skillCard")).toHaveCount(0);

  await page.click("#tab-skills");
  await expect(page.locator("#panel-skills")).toBeVisible();
  await expect.poll(async () => page.locator("#skillsList .skillCard").count()).toBeGreaterThan(0);
});

test("options persists automation toggle without save", async ({ harness }) => {
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
});

test("options exposes two AI connections and independent slide runtimes", async ({ harness }) => {
  await seedSettings(harness, { summaryRuntime: "direct", slideRuntime: "browser" });
  const page = await openExtensionPage(harness, "options.html", "#tabs");

  await expect(page.locator("#daemonStatus")).toContainText("Local companion permission missing");
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
});

test("options opens the requested runtime tab from the URL", async ({ harness }) => {
  const page = await openExtensionPage(harness, "options.html?tab=runtime", "#tabs");

  await expect(page.locator("#tab-runtime")).toHaveAttribute("aria-selected", "true");
  await expect(page.locator("#panel-runtime")).toBeVisible();

  await page.click("#tab-general");
  await expect(page).not.toHaveURL(/tab=runtime/);
  await expect(page.locator("#tab-general")).toHaveAttribute("aria-selected", "true");

  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector("#tabs");
  await expect(page.locator("#tab-general")).toHaveAttribute("aria-selected", "true");
  await expect(page.locator("#panel-general")).toBeVisible();
});

test("options stores an OpenAI key for direct mode without requiring the daemon", async ({
  harness,
}) => {
  await seedSettings(harness, {
    summaryRuntime: "daemon",
    slideRuntime: "daemon",
    provider: "openrouter",
    providerApiKeys: {},
  });
  const page = await openExtensionPage(harness, "options.html", "#tabs");

  await expect(page.locator("#daemonStatus")).toContainText("Local companion permission missing");
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
  await expect(page.locator("#daemonStatus")).toContainText("Local companion permission missing");
});

test("managed daemon disable locks the UI to Direct and Browser", async ({ harness }) => {
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
});

test("options persists direct provider credentials per provider", async ({ harness }) => {
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
});

test("options labels unavailable automation permissions as optional", async ({ harness }) => {
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
  await expect(page.locator("#automationPermissions")).toHaveText("Enable automation permissions");
  await expect(page.locator(".permissionHint")).toContainText("Optional for summarization");
  await expect(page.locator(".permissionHint")).toContainText("userScripts");
  await expect(page.locator(".permissionHint")).toContainText("debugger");
  await expect(page.locator("#userScriptsNotice")).toBeVisible();
  await expect(page.locator("#userScriptsNotice")).toContainText(/User Scripts|chrome:\/\//);
});

test("options grants User Scripts only after the explicit automation action", async ({
  harness,
}) => {
  await seedSettings(harness, { automationEnabled: true });
  const page = await openExtensionPage(harness, "options.html", "#tabs");
  const hasUserScripts = () =>
    page.evaluate(() => chrome.permissions.contains({ permissions: ["userScripts"] }));

  await expect.poll(hasUserScripts).toBe(false);
  await page.locator("#automationPermissions").click();
  await expect.poll(hasUserScripts).toBe(true);
});

test("options scheme list renders chips", async ({ harness }) => {
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
});

test("options footer links to summarize site", async ({ harness }) => {
  const page = await openExtensionPage(harness, "options.html", "#tabs");
  const summarizeLink = page.locator(".pageFooter a", { hasText: "Summarize" });
  await expect(summarizeLink).toHaveAttribute("href", /summarize\.sh/);
});

test("options persists a custom daemon port", async ({ harness }) => {
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
});
