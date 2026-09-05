import { expect, test } from "@playwright/test";
import {
  closeExtension,
  getBrowserFromProject,
  launchExtension,
  openExtensionPage,
  seedSettings,
} from "./helpers/extension-harness";

test("options renders Turkish interface without rewriting user skill metadata", async ({}, testInfo) => {
  const harness = await launchExtension(getBrowserFromProject(testInfo.project.name));

  try {
    await seedSettings(harness, { uiLocale: "tr" });
    const page = await openExtensionPage(harness, "options.html", "#tabs");
    await page.evaluate(async () => {
      await new Promise<void>((resolve) => {
        chrome.storage.local.set(
          {
            "automation.skillsSeeded": true,
            "automation.skills": {
              Delete: {
                name: "Delete",
                domainPatterns: ["example.com"],
                shortDescription: "Try again",
                description: "User-owned description",
                examples: "",
                library: "",
                createdAt: "2026-01-01T00:00:00.000Z",
                lastUpdated: "2026-01-01T00:00:00.000Z",
              },
            },
          },
          () => resolve(),
        );
      });
    });
    await page.reload();

    await expect(page.locator("body")).toHaveAttribute("data-locale-ui");
    await page.click("#tab-ui");
    await expect(page.locator("text=Arayüz dili")).toBeVisible();
    await expect(page.locator("#languagePreset option[value=tr]")).toHaveText("Türkçe");
    await expect(page.locator("#uiLocale")).toHaveValue("tr");
    await page.click("#tab-skills");
    await expect(page.locator("#panel-skills h2")).toHaveText("Otomasyon yetenekleri");
    await expect(page.locator(".skillName").filter({ hasText: "Delete" })).toHaveText("Delete");
    await expect(page.locator(".skillDomains")).toHaveText("example.com");
    await expect(page.locator(".skillDescription")).toHaveText("Try again");
    await page.locator("main").screenshot({ path: testInfo.outputPath("turkish-options.png") });
  } finally {
    await closeExtension(harness.context, harness.userDataDir);
  }
});

test("legacy profiles keep English on a Turkish browser", async ({}, testInfo) => {
  const harness = await launchExtension(getBrowserFromProject(testInfo.project.name));
  try {
    await harness.context.addInitScript(() => {
      Object.defineProperty(navigator, "language", { get: () => "tr-TR" });
    });
    await seedSettings(harness, { language: "tr", model: "auto", autoSummarize: false });
    const page = await openExtensionPage(harness, "options.html", "#tabs");
    await page.click("#tab-ui");
    try {
      await expect(page.locator("#uiLocale")).toHaveValue("en");
      await expect(page.locator("html")).toHaveAttribute("lang", "en");
    } finally {
      await page.locator("main").screenshot({ path: testInfo.outputPath("legacy-locale.png") });
    }
  } finally {
    await closeExtension(harness.context, harness.userDataDir);
  }
});

test("changing Options locale updates an already-open side panel", async ({}, testInfo) => {
  const harness = await launchExtension(getBrowserFromProject(testInfo.project.name));
  try {
    await seedSettings(harness, { uiLocale: "en", model: "auto", autoSummarize: false });
    const panel = await openExtensionPage(harness, "sidepanel.html", "#drawerToggle");
    const options = await openExtensionPage(harness, "options.html", "#tabs");
    await options.click("#tab-ui");
    await expect(panel.locator("html")).toHaveAttribute("lang", "en");
    await options.selectOption("#uiLocale", "tr");
    try {
      await expect(panel.locator("html")).toHaveAttribute("lang", "tr");
      await expect(panel.locator("#drawerToggle")).toHaveAttribute("aria-label", "Ayarlar");
    } finally {
      await panel.screenshot({ path: testInfo.outputPath("open-panel-locale.png") });
    }
    await options.selectOption("#uiLocale", "en");
    await expect(panel.locator("#drawerToggle")).toHaveAttribute("aria-label", "Settings");
  } finally {
    await closeExtension(harness.context, harness.userDataDir);
  }
});

test("Turkish UI preserves parsed diagnostic payloads", async ({}, testInfo) => {
  const harness = await launchExtension(getBrowserFromProject(testInfo.project.name));
  try {
    await seedSettings(harness, { uiLocale: "tr", autoSummarize: false });
    const page = await openExtensionPage(harness, "options.html", "#tabs");
    await expect(page.locator("html")).toHaveAttribute("lang", "tr");
    await page.evaluate(async () => {
      await chrome.storage.session.set({
        "summarize:extension-logs": ["Error: synthetic diagnostic must remain unchanged"],
      });
    });
    await page.click("#tab-logs");
    await page.selectOption("#logsSource", "extension");
    await page.click("#logsRefresh");
    try {
      await expect(page.locator("#logsTable tbody .details")).toContainText(
        "Error: synthetic diagnostic must remain unchanged",
      );
    } finally {
      await page.locator("main").screenshot({ path: testInfo.outputPath("diagnostic-locale.png") });
    }
  } finally {
    await closeExtension(harness.context, harness.userDataDir);
  }
});
