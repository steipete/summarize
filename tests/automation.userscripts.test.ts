import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildUserScriptsGuidance,
  getUserScriptsStatus,
} from "../apps/chrome-extension/src/automation/userscripts.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

const createStatus = (chromeVersion: number, apiAvailable = false, permissionGranted = true) => ({
  chromeVersion,
  apiAvailable,
  permissionGranted,
});

describe("immediate User Scripts execution support", () => {
  it.each([undefined, { register: () => {} }, { execute: "not callable" }])(
    "does not report namespace-only or non-callable APIs as ready (%j)",
    async (userScripts) => {
      vi.stubGlobal("navigator", { userAgent: "Chrome/134.0.0.0" });
      vi.stubGlobal("chrome", {
        userScripts,
        permissions: { contains: async () => true },
      });
      expect(await getUserScriptsStatus()).toEqual(createStatus(134));
    },
  );

  it("detects callable execution independently of the permission grant", async () => {
    const contains = vi.fn(async () => false);
    vi.stubGlobal("navigator", { userAgent: "Chrome/135.0.0.0" });
    vi.stubGlobal("chrome", {
      userScripts: { execute: async () => [] },
      permissions: { contains },
    });
    expect(await getUserScriptsStatus()).toEqual(createStatus(135, true, false));
    expect(contains).toHaveBeenCalledWith({ permissions: ["userScripts"] });
  });

  it.each([120, 134])("gives Chrome %i the execution upgrade requirement", (version) => {
    const guidance = buildUserScriptsGuidance(createStatus(version));
    expect(guidance).toContain("Chrome 135");
    expect(guidance).toContain("update Chrome");
    expect(guidance).not.toContain("Enable Developer mode");
    expect(guidance).not.toContain("permission is required");
  });

  it("retains Developer mode guidance for Chrome 135–137", () => {
    expect(buildUserScriptsGuidance(createStatus(136))).toContain("Enable Developer mode");
  });

  it("retains permission and toggle guidance for current Chrome", () => {
    const guidance = buildUserScriptsGuidance(createStatus(138, false, false));
    expect(guidance).toContain("Enable automation permissions");
    expect(guidance).toContain("Allow User Scripts");
  });

  it("prefers an available execution capability over the user-agent version", () => {
    const guidance = buildUserScriptsGuidance(createStatus(134, true, false));
    expect(guidance).toContain("Enable automation permissions");
    expect(guidance).not.toContain("update Chrome");
  });
});
