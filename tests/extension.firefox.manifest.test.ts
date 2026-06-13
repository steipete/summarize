import { describe, expect, it } from "vitest";
import extensionConfig from "../apps/chrome-extension/wxt.config.js";

describe("firefox extension manifest", () => {
  it("uses Firefox-compatible permissions and metadata", () => {
    const manifestFactory = (extensionConfig as { manifest?: unknown }).manifest;
    if (typeof manifestFactory !== "function") {
      throw new Error("Missing manifest factory in WXT config");
    }

    const manifest = manifestFactory({ browser: "firefox" }) as Record<string, unknown>;
    expect(manifest.sidebar_action).toBeTruthy();
    expect("side_panel" in manifest).toBe(false);

    const permissions = Array.isArray(manifest.permissions) ? manifest.permissions : [];
    expect(permissions).not.toContain("sidePanel");
    expect(permissions).not.toContain("userScripts");
    expect(permissions).not.toContain("windows");
    expect(manifest.optional_permissions).toEqual(["userScripts"]);

    const commands = manifest.commands as Record<string, unknown> | undefined;
    expect(commands?._execute_sidebar_action).toBeTruthy();

    const browserSettings = manifest.browser_specific_settings as
      | {
          gecko?: { strict_min_version?: string };
          gecko_android?: { strict_min_version?: string };
        }
      | undefined;
    expect(browserSettings?.gecko?.strict_min_version).toBe("140.0");
    expect(browserSettings?.gecko_android?.strict_min_version).toBe("142.0");
  });

  it("uses Chrome-compatible User Scripts permissions", () => {
    const manifestFactory = (extensionConfig as { manifest?: unknown }).manifest;
    if (typeof manifestFactory !== "function") {
      throw new Error("Missing manifest factory in WXT config");
    }

    const manifest = manifestFactory({ browser: "chrome" }) as Record<string, unknown>;
    const permissions = Array.isArray(manifest.permissions) ? manifest.permissions : [];
    expect(permissions).toContain("userScripts");
    expect(permissions).not.toContain("windows");
    expect(manifest.optional_permissions).toEqual([]);
    expect(manifest.minimum_chrome_version).toBe("120");
  });
});
