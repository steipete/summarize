import { afterEach, describe, expect, it, vi } from "vitest";
import { resolvePlatformKind } from "../apps/chrome-extension/src/entrypoints/sidepanel/setup-runtime";

function stubNavigator(value: Partial<Navigator> & { userAgentData?: { platform?: string } }) {
  vi.stubGlobal("navigator", value);
}

describe("sidepanel setup runtime", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("uses userAgentData platform when available", () => {
    stubNavigator({
      platform: "MacIntel",
      userAgent: "Mozilla/5.0",
      userAgentData: { platform: "Windows" },
    } as Navigator & { userAgentData: { platform: string } });

    expect(resolvePlatformKind()).toBe("windows");
  });

  it("falls back to navigator.platform when userAgentData platform is blank", () => {
    stubNavigator({
      platform: "MacIntel",
      userAgent: "Mozilla/5.0 (X11; Linux x86_64)",
      userAgentData: { platform: "   " },
    } as Navigator & { userAgentData: { platform: string } });

    expect(resolvePlatformKind()).toBe("mac");
  });
});
