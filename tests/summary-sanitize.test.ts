import { describe, expect, it } from "vitest";
import { sanitizeSummaryText } from "../src/run/summary-sanitize.js";

describe("summary sanitize", () => {
  it("strips explicit <think> blocks", () => {
    const input = `<think>\nplan\n</think>\n### Title\nReal summary body.`;
    const output = sanitizeSummaryText(input);
    expect(output).toBe("### Title\nReal summary body.");
  });

  it("drops planner preface before first structural marker", () => {
    const input = `Let me analyze the instructions first.\n[slide:1]\n## One\nText.`;
    const output = sanitizeSummaryText(input);
    expect(output).toBe("[slide:1]\n## One\nText.");
  });

  it("keeps regular summary text unchanged", () => {
    const input = "### Title\nNormal summary paragraph.";
    const output = sanitizeSummaryText(input);
    expect(output).toBe(input);
  });

  it("handles unclosed think tags by removing planner prefix", () => {
    const input = "<think>\nI need to follow output format.\n### Final\nClean summary.";
    const output = sanitizeSummaryText(input);
    expect(output).toBe("### Final\nClean summary.");
  });
});
