import { describe, expect, it } from "vitest";
import { isHoverSummarizeUrlAllowed } from "../apps/chrome-extension/src/entrypoints/background/hover-controller.js";
import { shouldHandleHoverTriggerEvent } from "../apps/chrome-extension/src/entrypoints/hover.content.js";

describe("hover summary security boundaries", () => {
  it("ignores synthetic hover events from page script", () => {
    expect(shouldHandleHoverTriggerEvent({ isTrusted: false })).toBe(false);
  });

  it("accepts browser-trusted hover events", () => {
    expect(shouldHandleHoverTriggerEvent({ isTrusted: true })).toBe(true);
  });

  it("rejects hover summaries for localhost and private literal hosts", () => {
    expect(isHoverSummarizeUrlAllowed("http://127.0.0.1:8080/admin")).toBe(false);
    expect(isHoverSummarizeUrlAllowed("http://[::1]:8080/admin")).toBe(false);
    expect(isHoverSummarizeUrlAllowed("http://10.0.0.5/metadata")).toBe(false);
    expect(isHoverSummarizeUrlAllowed("http://172.16.0.10/internal")).toBe(false);
    expect(isHoverSummarizeUrlAllowed("http://192.168.1.20/router")).toBe(false);
    expect(isHoverSummarizeUrlAllowed("http://169.254.169.254/latest/meta-data/")).toBe(false);
    expect(isHoverSummarizeUrlAllowed("http://localhost:8787/health")).toBe(false);
  });

  it("allows ordinary public http and https URLs", () => {
    expect(isHoverSummarizeUrlAllowed("https://example.com/article")).toBe(true);
    expect(isHoverSummarizeUrlAllowed("http://example.com/article")).toBe(true);
  });

  it("rejects non-http hover summary URLs", () => {
    expect(isHoverSummarizeUrlAllowed("file:///etc/passwd")).toBe(false);
    expect(isHoverSummarizeUrlAllowed("javascript:alert(1)")).toBe(false);
    expect(isHoverSummarizeUrlAllowed("notaurl")).toBe(false);
  });
});
