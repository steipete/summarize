import { describe, expect, it } from "vitest";
import extensionConfig, {
  resolveExtensionHostPermissions,
} from "../apps/chrome-extension/wxt.config.js";

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
    expect(permissions).not.toContain("debugger");
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

  it("keeps User Scripts optional and debugger out of the Chrome summary build", () => {
    const manifestFactory = (extensionConfig as { manifest?: unknown }).manifest;
    if (typeof manifestFactory !== "function") {
      throw new Error("Missing manifest factory in WXT config");
    }

    const manifest = manifestFactory({ browser: "chrome" }) as Record<string, unknown>;
    const permissions = Array.isArray(manifest.permissions) ? manifest.permissions : [];
    expect(permissions).not.toContain("userScripts");
    expect(permissions).not.toContain("debugger");
    expect(permissions).not.toContain("windows");
    expect(manifest.optional_permissions).toEqual(["nativeMessaging", "userScripts"]);
    expect(manifest.minimum_chrome_version).toBe("120");
  });

  it("adds required debugger access only to the explicit automation build", () => {
    const manifestFactory = (extensionConfig as { manifest?: unknown }).manifest;
    if (typeof manifestFactory !== "function") {
      throw new Error("Missing manifest factory in WXT config");
    }
    const previous = process.env.SUMMARIZE_EXTENSION_DEBUGGER;
    process.env.SUMMARIZE_EXTENSION_DEBUGGER = "1";
    try {
      const manifest = manifestFactory({ browser: "chrome" }) as Record<string, unknown>;
      const permissions = Array.isArray(manifest.permissions) ? manifest.permissions : [];
      expect(permissions).toContain("debugger");
      expect(manifest.optional_permissions).toEqual(["nativeMessaging", "userScripts"]);
    } finally {
      if (previous === undefined) delete process.env.SUMMARIZE_EXTENSION_DEBUGGER;
      else process.env.SUMMARIZE_EXTENSION_DEBUGGER = previous;
    }
  });

  it("grants broad capture permission only to Firefox and HTTP E2E builds", () => {
    expect(
      resolveExtensionHostPermissions({ browser: "chrome", e2eHttpTransport: false }),
    ).not.toContain("<all_urls>");
    expect(
      resolveExtensionHostPermissions({ browser: "chrome", e2eHttpTransport: true }),
    ).toContain("<all_urls>");
    expect(
      resolveExtensionHostPermissions({ browser: "firefox", e2eHttpTransport: false }),
    ).toContain("<all_urls>");
  });
});
