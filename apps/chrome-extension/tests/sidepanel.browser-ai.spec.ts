import { expect, test } from "@playwright/test";
import {
  assertNoErrors,
  buildUiState,
  closeExtension,
  getBrowserFromProject,
  launchExtension,
  openExtensionPage,
  sendBgMessage,
  trackErrors,
  waitForPanelPort,
} from "./helpers/extension-harness";
import {
  applySlidesPayload,
  getPanelModel,
  getPanelSlideDescriptions,
  getPanelSlidesSummaryComplete,
  getPanelSlidesSummaryMarkdown,
  getPanelSlidesSummaryModel,
  getPanelSummaryMarkdown,
} from "./helpers/panel-hooks";

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

test("browser AI creates distinct summaries for browser-extracted slides", async ({
  browserName: _browserName,
}, testInfo) => {
  const harness = await launchExtension(getBrowserFromProject(testInfo.project.name));

  try {
    const page = await openExtensionPage(harness, "sidepanel.html", "#title", () => {
      (
        globalThis as typeof globalThis & {
          __browserAiPromptCalls?: number;
          __browserAiPromptImageInputs?: number;
          __browserAiSlideSummarizerCalls?: number;
        }
      ).__browserAiPromptCalls = 0;
      (
        globalThis as typeof globalThis & {
          __browserAiPromptImageInputs?: number;
        }
      ).__browserAiPromptImageInputs = 0;
      (
        globalThis as typeof globalThis & {
          __browserAiSlideSummarizerCalls?: number;
        }
      ).__browserAiSlideSummarizerCalls = 0;
      Object.defineProperty(globalThis, "LanguageModel", {
        configurable: true,
        value: {
          availability: async () => "available",
          create: async (createOptions?: { expectedInputs?: Array<{ type?: string }> }) => ({
            contextWindow: 9_216,
            async measureContextUsage() {
              return 500;
            },
            async prompt(
              input:
                | string
                | Array<{
                    content?: Array<{ type?: string; value?: unknown }>;
                  }>,
              options?: { responseConstraint?: RegExp },
            ) {
              const scope = globalThis as typeof globalThis & {
                __browserAiPromptCalls?: number;
                __browserAiPromptImageInputs?: number;
              };
              scope.__browserAiPromptCalls = (scope.__browserAiPromptCalls ?? 0) + 1;
              scope.__browserAiPromptImageInputs =
                typeof input === "string"
                  ? 0
                  : input
                      .flatMap((message) => message.content ?? [])
                      .filter(
                        (content) => content.type === "image" && content.value instanceof Blob,
                      ).length;
              if (!createOptions?.expectedInputs?.some((expected) => expected.type === "image")) {
                throw new DOMException("Missing image modality", "NotSupportedError");
              }
              const result =
                "[slide:1] Linear classifiers learn a decision boundary between labeled examples.\n" +
                "[slide:2] The sigmoid converts model scores into class probabilities.";
              if (!options?.responseConstraint?.test(result)) {
                throw new DOMException("Constraint mismatch", "SyntaxError");
              }
              return result;
            },
            destroy() {},
          }),
        },
      });
      Object.defineProperty(globalThis, "Summarizer", {
        configurable: true,
        value: {
          availability: async () => "available",
          create: async () => ({
            async summarize(input: string, options?: { context?: string }) {
              if (options?.context?.includes("slide 1 of 2")) {
                const scope = globalThis as typeof globalThis & {
                  __browserAiSlideSummarizerCalls?: number;
                };
                scope.__browserAiSlideSummarizerCalls =
                  (scope.__browserAiSlideSummarizerCalls ?? 0) + 1;
                return "Linear classifiers learn a decision boundary between labeled examples.";
              }
              if (options?.context?.includes("slide 2 of 2")) {
                const scope = globalThis as typeof globalThis & {
                  __browserAiSlideSummarizerCalls?: number;
                };
                scope.__browserAiSlideSummarizerCalls =
                  (scope.__browserAiSlideSummarizerCalls ?? 0) + 1;
                return "The sigmoid converts model scores into class probabilities.";
              }
              return `Overall summary of ${input.slice(0, 20)}.`;
            },
          }),
        },
      });
    });
    trackErrors(page, harness.pageErrors, harness.consoleErrors);
    await waitForPanelPort(page);
    const url = "https://www.youtube.com/watch?v=browser-ai-slides";
    const uiState = buildUiState({
      tab: { id: 1, url, title: "Machine Learning Lecture" },
    });
    Object.assign(uiState.settings, {
      slideRuntime: "browser",
      summaryRuntime: "direct",
      providerConfigured: false,
      model: "auto",
    });

    await sendBgMessage(harness, {
      type: "ui:state",
      state: uiState,
    });
    await sendBgMessage(harness, {
      type: "run:snapshot",
      run: {
        id: "browser-ai-slides-summary",
        url,
        title: "Machine Learning Lecture",
        model: "Browser",
        reason: "manual",
      },
      markdown: "## Machine Learning Lecture\n\nFallback summary.",
      browserAi: {
        text: "The lecture introduces classification and logistic regression.",
        length: "long",
        keyMoments: [],
      },
    });
    await applySlidesPayload(page, {
      sourceUrl: url,
      sourceId: "browser-ai-slide-source",
      sourceKind: "youtube",
      slideRuntime: "browser",
      ocrAvailable: false,
      transcriptTimedText:
        "[00:00] The first section explains linear decision boundaries and labeled examples.\n" +
        "[01:00] The second section derives the sigmoid and probability interpretation.",
      slides: [
        {
          index: 1,
          timestamp: 0,
          imageUrl:
            "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2xZkAAAAASUVORK5CYII=",
        },
        {
          index: 2,
          timestamp: 60,
          imageUrl:
            "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2xZkAAAAASUVORK5CYII=",
        },
      ],
    });

    await expect.poll(() => getPanelSlidesSummaryComplete(page)).toBe(true);
    await expect.poll(() => getPanelSlidesSummaryModel(page)).toBe("Gemini Nano");
    const markdown = await getPanelSlidesSummaryMarkdown(page);
    expect(markdown).toContain("[slide:1]");
    expect(markdown).toContain("Linear classifiers learn a decision boundary");
    expect(markdown).toContain("[slide:2]");
    expect(markdown).toContain("The sigmoid converts model scores");
    expect(markdown).not.toContain("The first section explains");
    expect(await getPanelSlideDescriptions(page)).toEqual([
      [1, "Linear classifiers learn a decision boundary between labeled examples."],
      [2, "The sigmoid converts model scores into class probabilities."],
    ]);
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (
              globalThis as typeof globalThis & {
                __browserAiPromptCalls?: number;
              }
            ).__browserAiPromptCalls ?? 0,
        ),
      )
      .toBe(1);
    expect(
      await page.evaluate(
        () =>
          (
            globalThis as typeof globalThis & {
              __browserAiPromptImageInputs?: number;
            }
          ).__browserAiPromptImageInputs ?? 0,
      ),
    ).toBe(2);
    expect(
      await page.evaluate(
        () =>
          (
            globalThis as typeof globalThis & {
              __browserAiSlideSummarizerCalls?: number;
            }
          ).__browserAiSlideSummarizerCalls ?? 0,
      ),
    ).toBe(0);
    assertNoErrors(harness);
  } finally {
    await closeExtension(harness.context, harness.userDataDir);
  }
});
