// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { createModelPresetsController } from "../apps/chrome-extension/src/entrypoints/sidepanel/model-presets.js";
import type { Settings } from "../apps/chrome-extension/src/lib/settings.js";

const jsonResponse = (body: unknown) =>
  new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });

const createDeferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

const flushAsyncWork = () => new Promise<void>((resolve) => window.setTimeout(resolve, 0));

const createController = () => {
  const modelPresetEl = document.createElement("select");
  const modelCustomEl = document.createElement("input");
  const modelRefreshBtn = document.createElement("button");
  const modelStatusEl = document.createElement("div");
  const modelRowEl = document.createElement("div");
  const controller = createModelPresetsController({
    modelPresetEl,
    modelCustomEl,
    modelRefreshBtn,
    modelStatusEl,
    modelRowEl,
    defaultModel: "auto",
    loadSettings: async () => ({ token: "token" }) as Settings,
    friendlyFetchError: (error) => (error instanceof Error ? error.message : String(error)),
  });
  controller.setDefaultPresets();
  return { controller, modelPresetEl, modelCustomEl };
};

describe("sidepanel model presets", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("preserves a user selection made while refresh is pending", async () => {
    const refresh = createDeferred<Response>();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => refresh.promise),
    );
    const { controller, modelPresetEl, modelCustomEl } = createController();

    const refreshPromise = controller.refreshPresets("token");
    controller.setValue("openai/user-choice");

    refresh.resolve(
      jsonResponse({
        ok: true,
        providers: { openai: true },
        options: [{ id: "openai/from-refresh", label: "From refresh" }],
      }),
    );
    await refreshPromise;
    await flushAsyncWork();

    expect(controller.readCurrentValue()).toBe("openai/user-choice");
    expect(modelPresetEl.value).toBe("custom");
    expect(modelCustomEl.hidden).toBe(false);
    expect(modelCustomEl.value).toBe("openai/user-choice");
  });

  it("ignores older token results that resolve after a newer refresh", async () => {
    const oldRefresh = createDeferred<Response>();
    const newRefresh = createDeferred<Response>();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
        const token = String(new Headers(init?.headers).get("Authorization") ?? "");
        if (token.endsWith("old")) return oldRefresh.promise;
        if (token.endsWith("new")) return newRefresh.promise;
        throw new Error(`unexpected token: ${token}`);
      }),
    );
    const { controller, modelPresetEl } = createController();

    const oldPromise = controller.refreshPresets("old");
    const newPromise = controller.refreshPresets("new");

    newRefresh.resolve(
      jsonResponse({
        ok: true,
        options: [{ id: "new/model", label: "New model" }],
      }),
    );
    await newPromise;
    oldRefresh.resolve(
      jsonResponse({
        ok: true,
        options: [{ id: "old/model", label: "Old model" }],
      }),
    );
    await oldPromise;
    await flushAsyncWork();

    expect(Array.from(modelPresetEl.options).map((option) => option.value)).toContain("new/model");
    expect(Array.from(modelPresetEl.options).map((option) => option.value)).not.toContain(
      "old/model",
    );
  });
});
