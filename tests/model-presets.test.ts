// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import { createModelPresetsController as createPanelController } from "../apps/chrome-extension/src/entrypoints/sidepanel/model-presets.js";
import { createModelPresetsController as createSharedController } from "../apps/chrome-extension/src/lib/model-presets.js";
import { defaultSettings } from "../apps/chrome-extension/src/lib/settings.js";

const jsonResponse = (body: unknown) =>
  new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });

function createController(surface: "options" | "panel", fetchImpl: typeof fetch) {
  const presetEl = document.createElement("select");
  const customEl = document.createElement("input");
  const refreshButton = document.createElement("button");
  const row = document.createElement("div");
  const controller =
    surface === "options"
      ? createSharedController({
          presetEl,
          customEl,
          defaultValue: "auto",
          includeCliHints: true,
          fetchImpl,
        })
      : createPanelController({
          modelPresetEl: presetEl,
          modelCustomEl: customEl,
          modelRefreshBtn: refreshButton,
          modelStatusEl: document.createElement("div"),
          modelRowEl: row,
          defaultModel: "auto",
          loadSettings: async () => ({ ...defaultSettings, token: "token" }),
          friendlyFetchError: String,
          fetchImpl,
        });
  controller.setDefaultPresets();
  return { controller, presetEl, customEl, refreshButton, row };
}

describe.each(["options", "panel"] as const)("%s model presets", (surface) => {
  it("preserves a user selection made while refresh is pending", async () => {
    const refresh = Promise.withResolvers<Response>();
    const { controller, presetEl, customEl } = createController(
      surface,
      async () => refresh.promise,
    );
    const pending = controller.refreshPresets("token");
    controller.setValue("openai/user-choice");
    refresh.resolve(
      jsonResponse({
        ok: true,
        providers: { openai: true },
        options: [{ id: "openai/from-refresh", label: "From refresh" }],
      }),
    );
    await pending;
    expect(controller.readCurrentValue()).toBe("openai/user-choice");
    expect(presetEl.value).toBe("custom");
    expect(customEl.hidden).toBe(false);
    expect(customEl.value).toBe("openai/user-choice");
  });

  it("ignores older token results that resolve after a newer refresh", async () => {
    const oldRefresh = Promise.withResolvers<Response>();
    const newRefresh = Promise.withResolvers<Response>();
    const { controller, presetEl } = createController(surface, async (_input, init) =>
      new Headers(init?.headers).get("Authorization")?.endsWith("old")
        ? oldRefresh.promise
        : newRefresh.promise,
    );
    const oldPending = controller.refreshPresets("old");
    const newPending = controller.refreshPresets("new");
    newRefresh.resolve(
      jsonResponse({ ok: true, options: [{ id: "new/model", label: "New model" }] }),
    );
    await newPending;
    oldRefresh.resolve(
      jsonResponse({ ok: true, options: [{ id: "old/model", label: "Old model" }] }),
    );
    await oldPending;
    const values = Array.from(presetEl.options, (option) => option.value);
    expect(values).toContain("new/model");
    expect(values).not.toContain("old/model");
  });

  it("ignores a stale response whose body resolves after the token is cleared", async () => {
    const body = Promise.withResolvers<unknown>();
    const response = jsonResponse({});
    const readBody = vi.spyOn(response, "json").mockImplementation(() => body.promise);
    const { controller, presetEl } = createController(surface, async () => response);
    const pending = controller.refreshPresets("token");
    await vi.waitFor(() => expect(readBody).toHaveBeenCalledOnce());
    await controller.refreshPresets("");
    body.resolve({ ok: true, options: [{ id: "stale/model" }] });
    await pending;
    expect(Array.from(presetEl.options, (option) => option.value)).not.toContain("stale/model");
  });

  it("retains screen-specific defaults, provider hints, and custom-value reading", async () => {
    const { controller, presetEl, customEl, refreshButton, row } = createController(
      surface,
      async () =>
        jsonResponse({ ok: true, providers: { openai: true, cliCodex: true }, options: [] }),
    );
    expect(Array.from(presetEl.options, (option) => option.value)).toEqual(
      surface === "panel"
        ? ["auto", "browser/gemini-nano", "gpt-fast", "free", "custom"]
        : ["auto", "browser/gemini-nano", "gpt-fast", "custom"],
    );
    await controller.refreshPresets("token");
    expect(customEl.placeholder).toBe(
      `auto / gpt-fast / openai/…${surface === "options" ? " / cli/codex" : ""}`,
    );
    controller.setValue("custom/model");
    customEl.value = " custom/model ";
    expect(controller.readCurrentValue()).toBe(
      surface === "panel" ? "custom/model" : " custom/model ",
    );
    if (surface === "panel") {
      expect(row.classList.contains("isCustom")).toBe(true);
      expect(refreshButton.hidden).toBe(true);
      controller.setValue("free");
      expect(customEl.hidden).toBe(true);
      expect(row.classList.contains("isCustom")).toBe(false);
      expect(refreshButton.hidden).toBe(false);
    }
  });

  it("normalizes discovery options and preserves empty custom input", async () => {
    const { controller, presetEl, customEl } = createController(surface, async () =>
      jsonResponse({
        ok: true,
        options: [
          null,
          { id: "" },
          { id: "auto", label: "wrong" },
          { id: " model ", label: " Label " },
          { id: "model", label: "duplicate" },
        ],
      }),
    );
    controller.setValue("custom/model");
    customEl.value = "";
    await controller.refreshPresets("token");
    expect(
      Array.from(presetEl.options)
        .filter((option) => option.value === "model")
        .map((option) => option.textContent),
    ).toEqual(["model — Label"]);
    expect(presetEl.value).toBe("custom");
    expect(customEl.value).toBe("");
    expect(customEl.hidden).toBe(false);
  });
});
