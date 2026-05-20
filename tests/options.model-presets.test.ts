// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { createModelPresetsController } from "../apps/chrome-extension/src/entrypoints/options/model-presets.js";

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

const createController = (fetchImpl: typeof fetch) => {
  const presetEl = document.createElement("select");
  const customEl = document.createElement("input");
  const controller = createModelPresetsController({
    presetEl,
    customEl,
    defaultValue: "auto",
    fetchImpl,
  });
  return { controller, presetEl, customEl };
};

describe("options model presets", () => {
  it("preserves a user selection made while refresh is pending", async () => {
    const refresh = createDeferred<Response>();
    const fetchImpl = async () => refresh.promise;
    const { controller, presetEl, customEl } = createController(fetchImpl);

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
    expect(presetEl.value).toBe("custom");
    expect(customEl.hidden).toBe(false);
    expect(customEl.value).toBe("openai/user-choice");
  });

  it("ignores older token results that resolve after a newer refresh", async () => {
    const oldRefresh = createDeferred<Response>();
    const newRefresh = createDeferred<Response>();
    const fetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
      const token = String(new Headers(init?.headers).get("Authorization") ?? "");
      if (token.endsWith("old")) return oldRefresh.promise;
      if (token.endsWith("new")) return newRefresh.promise;
      throw new Error(`unexpected token: ${token}`);
    };
    const { controller, presetEl } = createController(fetchImpl);

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

    expect(Array.from(presetEl.options).map((option) => option.value)).toContain("new/model");
    expect(Array.from(presetEl.options).map((option) => option.value)).not.toContain("old/model");
  });
});
