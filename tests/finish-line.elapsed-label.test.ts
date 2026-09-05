import { describe, expect, it } from "vitest";
import { buildFinishLineText, writeFinishLine } from "../src/run/finish-line.js";

const baseReport = {
  llm: [{ promptTokens: 1, completionTokens: 1, totalTokens: 2, calls: 1 }],
  services: { firecrawl: { requests: 0 }, apify: { requests: 0 } },
};

describe("finish line elapsed label", () => {
  it("preserves model identifiers while translating the finish line", () => {
    let output = "";
    writeFinishLine({
      stderr: {
        write: (text: string) => {
          output += text;
        },
      } as NodeJS.WritableStream,
      elapsedMs: 1000,
      elapsedLabel: "Cached",
      label: "Slides",
      model: "old",
      report: baseReport,
      costUsd: null,
      detailed: false,
      color: false,
      env: { SUMMARIZE_LOCALE: "tr" },
    });
    expect(output).toContain("old");
    expect(output).toContain("Slaytlar");
  });

  it("uses custom elapsed label when provided", () => {
    const text = buildFinishLineText({
      elapsedMs: 0,
      elapsedLabel: "Cached",
      label: "Example",
      model: "openrouter/xiaomi/mimo-v2-flash:free",
      report: baseReport,
      costUsd: null,
      detailed: false,
      extraParts: null,
    });

    expect(text.line.split(" · ")[0]).toBe("Cached");
  });

  it("falls back to formatted time when elapsed label is blank", () => {
    const text = buildFinishLineText({
      elapsedMs: 1050,
      elapsedLabel: "   ",
      label: null,
      model: null,
      report: baseReport,
      costUsd: null,
      detailed: false,
      extraParts: null,
    });

    expect(text.line.startsWith("1.1s")).toBe(true);
  });
});
