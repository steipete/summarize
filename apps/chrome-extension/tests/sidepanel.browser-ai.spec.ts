import { expect, test } from "@playwright/test";
import {
  assertNoErrors,
  closeExtension,
  getBrowserFromProject,
  launchExtension,
  openExtensionPage,
  sendBgMessage,
  trackErrors,
  waitForPanelPort,
} from "./helpers/extension-harness";
import { getPanelModel, getPanelSummaryMarkdown } from "./helpers/panel-hooks";

test("browser AI keeps the native session receiver", async ({
  browserName: _browserName,
}, testInfo) => {
  const harness = await launchExtension(getBrowserFromProject(testInfo.project.name));

  try {
    const page = await openExtensionPage(harness, "sidepanel.html", "#title", () => {
      const session = {
        inputQuota: 10_000,
        async measureInputUsage(this: unknown, input: string) {
          if (this !== session) throw new TypeError("Illegal invocation");
          return input.length;
        },
        async summarize(this: unknown) {
          if (this !== session) throw new TypeError("Illegal invocation");
          return "* Native summary point\n* Another native point";
        },
      };
      Object.defineProperty(globalThis, "Summarizer", {
        configurable: true,
        value: {
          availability: async () => "available",
          create: async () => session,
        },
      });
    });
    trackErrors(page, harness.pageErrors, harness.consoleErrors);
    await waitForPanelPort(page);

    await sendBgMessage(harness, {
      type: "run:snapshot",
      run: {
        id: "browser-ai-test",
        url: "https://example.com/article",
        title: "Native summary",
        model: "Browser",
        reason: "manual",
      },
      markdown: "## Native summary\n\nFallback summary.",
      browserAi: {
        text: "A sufficiently detailed article for the native summarizer.",
        length: "long",
        keyMoments: [],
      },
    });

    await expect.poll(() => getPanelModel(page)).toBe("Gemini Nano");
    await expect.poll(() => getPanelSummaryMarkdown(page)).toContain("- Native summary point");
    assertNoErrors(harness);
  } finally {
    await closeExtension(harness.context, harness.userDataDir);
  }
});
