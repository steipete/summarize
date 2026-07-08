import { beforeEach, describe, expect, it, vi } from "vitest";
import { getAutomationToolNames } from "../apps/chrome-extension/src/automation/tools.js";
import { resolveDirectTools } from "../apps/chrome-extension/src/lib/direct-prompts.js";

describe("automation build capabilities", () => {
  beforeEach(() => {
    vi.stubGlobal("chrome", {
      runtime: { getManifest: () => ({ permissions: ["tabs"] }) },
    });
  });

  it("hides debugger tools from summary builds", () => {
    expect(getAutomationToolNames()).not.toContain("debugger");
    expect(resolveDirectTools(true, ["navigate", "debugger"]).map((tool) => tool.name)).toEqual([
      "navigate",
    ]);
  });

  it("exposes debugger tools in debugger-enabled automation builds", () => {
    vi.stubGlobal("chrome", {
      runtime: { getManifest: () => ({ permissions: ["tabs", "debugger"] }) },
    });

    expect(getAutomationToolNames()).toContain("debugger");
    expect(resolveDirectTools(true, ["navigate", "debugger"]).map((tool) => tool.name)).toEqual([
      "navigate",
      "debugger",
    ]);
  });
});
