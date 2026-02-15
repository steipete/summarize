import { describe, expect, it } from "vitest";
import { buildLinkSummaryPrompt } from "../packages/core/src/prompts/index.js";

describe("buildLinkSummaryPrompt (slides)", () => {
  it("adds slide timeline guidance with overview paragraph first", () => {
    const prompt = buildLinkSummaryPrompt({
      url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      title: "Test",
      siteName: "YouTube",
      description: null,
      content: "Transcript:\n[0:01] Hello",
      truncated: false,
      hasTranscript: true,
      hasTranscriptTimestamps: true,
      slides: { count: 8, text: "Slide 1 [0:00–0:30]:\nHello" },
      outputLanguage: { kind: "fixed", tag: "en", label: "English" },
      summaryLength: "short",
      shares: [],
    });

    expect(prompt).toContain(
      "Slide format example (follow this pattern; markers on their own lines):",
    );
    expect(prompt).toContain("Required markers (use each exactly once, in order)");
    expect(prompt).toContain("Repeat the 3-line slide block for every marker below, in order.");
    expect(prompt).toContain('Every slide must include a headline line that starts with "## ".');
    expect(prompt).toContain("If there is no obvious title, create a short 2-6 word headline");
    expect(prompt).toContain('Never output "Title:" or "Slide 1/10".');
    expect(prompt).toContain("Do not create a dedicated Slides section or list");
    expect(prompt).toContain("Use third-person prose");
    expect(prompt).toContain("do not include direct quotes or transcript excerpts");
    expect(prompt).toContain("rewrite transcript-like direct speech into concise neutral summaries");
    expect(prompt).not.toContain("Include at least 3 headings");
  });
});
