import { describe, expect, it } from "vitest";
import {
  resolveCapabilityExecution,
  resolveCapabilityModel,
  resolveSummaryExecution,
} from "../apps/chrome-extension/src/lib/model-routing.js";
import { defaultSettings } from "../apps/chrome-extension/src/lib/settings.js";

describe("chrome model routing", () => {
  it("uses Gemini Nano for Direct Auto without provider credentials", () => {
    expect(resolveSummaryExecution(defaultSettings)).toBe("browser");
  });

  it("uses the configured provider for Direct Auto", () => {
    expect(
      resolveSummaryExecution({
        ...defaultSettings,
        providerApiKeys: { openai: "key" },
      }),
    ).toBe("direct");
  });

  it("does not use a stored key for an unselected provider", () => {
    expect(
      resolveSummaryExecution({
        ...defaultSettings,
        provider: "openai",
        providerApiKeys: { anthropic: "key" },
      }),
    ).toBe("browser");
  });

  it("keeps explicit Gemini Nano local in Daemon mode", () => {
    expect(
      resolveSummaryExecution({
        ...defaultSettings,
        summaryRuntime: "daemon",
        model: "browser/gemini-nano",
      }),
    ).toBe("browser");
  });

  it("routes summary-only Nano capabilities through the selected connection", () => {
    expect(resolveCapabilityExecution(defaultSettings)).toBe("unavailable");
    expect(
      resolveCapabilityExecution({
        ...defaultSettings,
        provider: "anthropic",
        providerApiKeys: { anthropic: "key" },
      }),
    ).toBe("direct");
    expect(
      resolveCapabilityExecution({
        ...defaultSettings,
        summaryRuntime: "daemon",
      }),
    ).toBe("daemon");
    expect(resolveCapabilityModel("browser/gemini-nano")).toBe("auto");
  });

  it("uses credentials for an explicit provider-prefixed capability model", () => {
    expect(
      resolveCapabilityExecution({
        ...defaultSettings,
        provider: "openai",
        model: "anthropic/claude-sonnet-4-5",
        providerApiKeys: { anthropic: "key" },
      }),
    ).toBe("direct");
  });
});
