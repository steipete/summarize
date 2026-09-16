import { describe, expect, it } from "vitest";
import {
  buildMetricsParts,
  buildMetricsTokens,
  readMetricParts,
} from "../apps/chrome-extension/src/lib/metrics.js";

describe("chrome metrics", () => {
  it("validates numeric descriptors and permits only HTTP source links", () => {
    expect(
      readMetricParts([{ kind: "message", message: { key: "metrics.elapsed", values: {} } }]),
    ).toBeNull();
    expect(
      readMetricParts([{ kind: "message", message: { key: "not.a.message", values: {} } }]),
    ).toBeNull();
    expect(
      readMetricParts([{ kind: "text", text: "Try again", href: "javascript:alert(1)" }]),
    ).toEqual([{ text: "Try again", model: false }]);
    expect(
      readMetricParts([{ kind: "text", text: "Try again", href: "https://example.com" }]),
    ).toEqual([{ text: "Try again", model: false, href: "https://example.com" }]);
  });
  it("omits input summary duplicates", () => {
    const summary = "7.5s · example.com · 2.1k words · openrouter/foo/bar";
    const parts = buildMetricsParts({
      summary,
      inputSummary: "2.1k words · 7.5s",
    });
    expect(parts).toEqual(["example.com", "openrouter/foo/bar"]);
  });

  it("shortens OpenRouter prefix when requested", () => {
    const summary = "Cached · openrouter/xiaomi/mimo-v2:free";
    const parts = buildMetricsParts({ summary, shortenOpenRouter: true });
    expect(parts).toEqual(["Cached", "or/xiaomi/mimo-v2:free"]);
  });

  it("builds link tokens for urls and domains", () => {
    const tokens = buildMetricsTokens({
      summary: "example.com · https://example.com/docs",
      inputSummary: null,
    });
    expect(tokens).toEqual([
      { kind: "link", text: "example.com", href: "https://example.com" },
      { kind: "link", text: "https://example.com/docs", href: "https://example.com/docs" },
    ]);
  });

  it("links media labels to source url", () => {
    const tokens = buildMetricsTokens({
      summary: "12m YouTube · 1.2k words",
      inputSummary: null,
      sourceUrl: "https://youtube.com/watch?v=test",
    });
    expect(tokens[0]).toEqual({
      kind: "media",
      before: "12m ",
      label: "YouTube",
      after: "",
      href: "https://youtube.com/watch?v=test",
    });
  });
});
