import { describe, expect, it } from "vitest";
import { buildBrowserSummaryMarkdown } from "../apps/chrome-extension/src/entrypoints/background/browser-summary";

describe("chrome browser summary", () => {
  it("escapes browser-derived Markdown before rendering in the sidepanel", () => {
    const markdown = buildBrowserSummaryMarkdown({
      title: "Demo ![title](https://example.test/title.png)",
      text: "Intro ![image](https://example.test/pixel.png) and [link](https://example.test).",
      transcriptTimedText:
        "[0:01] Moment ![slide](https://example.test/slide.png)\n[0:02] Follow-up [link](https://example.test).",
    });

    expect(markdown).toContain("## Demo \\!\\[title\\]\\(https://example\\.test/title\\.png\\)");
    expect(markdown).toContain("\\!\\[slide\\]\\(https://example\\.test/slide\\.png\\)");
    expect(markdown).toContain("\\[link\\]\\(https://example\\.test\\)");
    expect(markdown).not.toContain("![");
    expect(markdown).not.toContain("](https://example.test");
  });
});
