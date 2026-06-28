import { describe, expect, it } from "vitest";
import { isHoverSummarizeUrlAllowed } from "../apps/chrome-extension/src/entrypoints/background/hover-controller.js";
import {
  shouldHandleHoverTriggerEvent,
  shouldStartHoverRequest,
} from "../apps/chrome-extension/src/entrypoints/hover.content.js";

describe("hover summary security boundaries", () => {
  it("ignores synthetic hover events from page script", () => {
    expect(shouldHandleHoverTriggerEvent({ isTrusted: false })).toBe(false);
  });

  it("accepts browser-trusted hover events", () => {
    expect(shouldHandleHoverTriggerEvent({ isTrusted: true })).toBe(true);
  });

  it("does not require a daemon token before asking the background to summarize", () => {
    expect(shouldStartHoverRequest({ hoverSummaries: true })).toBe(true);
  });

  it("does not require a daemon token for configured direct hover summaries", () => {
    expect(
      shouldStartHoverRequest({
        hoverSummaries: true,
        model: "auto",
        provider: "openai",
        providerApiKeys: { openai: "test-key" },
        summaryRuntime: "direct",
        token: "",
      }),
    ).toBe(true);
  });

  it("requires a daemon token for daemon-backed hover summaries", () => {
    expect(
      shouldStartHoverRequest({
        hoverSummaries: true,
        model: "auto",
        provider: "openai",
        providerApiKeys: { openai: "test-key" },
        summaryRuntime: "daemon",
        token: "",
      }),
    ).toBe(false);
  });

  it("respects disabled hover summaries before asking the background to summarize", () => {
    expect(shouldStartHoverRequest({ hoverSummaries: false })).toBe(false);
    expect(shouldStartHoverRequest(null)).toBe(false);
  });

  it("rejects hover summaries for localhost and private literal hosts", () => {
    expect(isHoverSummarizeUrlAllowed("http://127.0.0.1:8080/admin")).toBe(false);
    expect(isHoverSummarizeUrlAllowed("http://0.0.0.0:8787/health")).toBe(false);
    expect(isHoverSummarizeUrlAllowed("http://[::1]:8080/admin")).toBe(false);
    expect(isHoverSummarizeUrlAllowed("http://[::]/metadata")).toBe(false);
    expect(isHoverSummarizeUrlAllowed("http://[fe80::1]/metadata")).toBe(false);
    expect(isHoverSummarizeUrlAllowed("http://[fd00::1]/metadata")).toBe(false);
    expect(isHoverSummarizeUrlAllowed("http://10.0.0.5/metadata")).toBe(false);
    expect(isHoverSummarizeUrlAllowed("http://172.16.0.10/internal")).toBe(false);
    expect(isHoverSummarizeUrlAllowed("http://192.168.1.20/router")).toBe(false);
    expect(isHoverSummarizeUrlAllowed("http://169.254.169.254/latest/meta-data/")).toBe(false);
    expect(isHoverSummarizeUrlAllowed("http://100.64.0.1/internal")).toBe(false);
    expect(isHoverSummarizeUrlAllowed("http://224.0.0.1/multicast")).toBe(false);
    expect(isHoverSummarizeUrlAllowed("http://[::ffff:127.0.0.1]/admin")).toBe(false);
    expect(isHoverSummarizeUrlAllowed("http://[::ffff:0:c0a8:101]/admin")).toBe(false);
    expect(isHoverSummarizeUrlAllowed("http://localhost:8787/health")).toBe(false);
    expect(isHoverSummarizeUrlAllowed("http://panel.localhost/admin")).toBe(false);
    expect(isHoverSummarizeUrlAllowed("http://printer.local/status")).toBe(false);
  });

  it("allows ordinary public http and https URLs", () => {
    expect(isHoverSummarizeUrlAllowed("https://example.com/article")).toBe(true);
    expect(isHoverSummarizeUrlAllowed("http://example.com/article")).toBe(true);
    expect(isHoverSummarizeUrlAllowed("http://8.8.8.8/dns")).toBe(true);
    expect(isHoverSummarizeUrlAllowed("http://172.32.0.1/public")).toBe(true);
  });

  it("rejects non-http hover summary URLs", () => {
    expect(isHoverSummarizeUrlAllowed("file:///etc/passwd")).toBe(false);
    expect(isHoverSummarizeUrlAllowed("javascript:alert(1)")).toBe(false);
    expect(isHoverSummarizeUrlAllowed("notaurl")).toBe(false);
  });
});
