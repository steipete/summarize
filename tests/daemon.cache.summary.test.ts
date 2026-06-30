import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { executeSummarize } from "../src/application/execute-summarize.js";
import { createCacheStore } from "../src/cache.js";
import { buildDaemonSummaryMetrics } from "../src/daemon/summarize-presentation.js";
import type { ExecFileFn } from "../src/markitdown.js";
import { createEmptyRunOverrides } from "../src/run/run-settings.js";
import { makeAssistantMessage, makeTextDeltaStream } from "./helpers/pi-ai-mock.js";

const mocks = vi.hoisted(() => ({
  streamSimple: vi.fn(),
  getModel: vi.fn(() => {
    throw new Error("no model");
  }),
}));

vi.mock("@earendil-works/pi-ai/compat", () => ({
  streamSimple: mocks.streamSimple,
  getModel: mocks.getModel,
}));

describe("daemon summary cache", () => {
  it("reuses cached summary for visible page requests", async () => {
    mocks.streamSimple.mockImplementation(() =>
      makeTextDeltaStream(
        ["### Overview\n- Cached summary.\n"],
        makeAssistantMessage({
          text: "### Overview\n- Cached summary.\n",
          usage: { input: 1, output: 1, totalTokens: 2 },
        }),
      ),
    );
    mocks.streamSimple.mockClear();

    const root = mkdtempSync(join(tmpdir(), "summarize-daemon-cache-"));
    const summarizeDir = join(root, ".summarize");
    const cacheDir = join(summarizeDir, "cache");
    mkdirSync(cacheDir, { recursive: true });

    writeFileSync(
      join(cacheDir, "litellm-model_prices_and_context_window.json"),
      JSON.stringify({ "gpt-5.2": { max_input_tokens: 999_999 } }),
      "utf8",
    );
    writeFileSync(
      join(cacheDir, "litellm-model_prices_and_context_window.meta.json"),
      JSON.stringify({ fetchedAtMs: Date.now() }),
      "utf8",
    );

    const globalFetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      throw new Error("unexpected LiteLLM catalog fetch");
    });

    const cachePath = join(summarizeDir, "cache.sqlite");
    const store = await createCacheStore({ path: cachePath, maxBytes: 1024 * 1024 });
    const cacheState = {
      mode: "default" as const,
      store,
      ttlMs: 30 * 24 * 60 * 60 * 1000,
      maxBytes: 1024 * 1024,
      path: cachePath,
    };

    const runOnce = async () => {
      let out = "";
      const events: Array<{ type: string; cached?: boolean }> = [];
      const result = await executeSummarize(
        {
          input: {
            kind: "visible-page",
            url: "https://example.com/article",
            title: "Hello",
            text: "Content",
            truncated: false,
          },
          modelOverride: "openai/gpt-5.2",
          promptOverride: null,
          lengthRaw: "xl",
          languageRaw: "auto",
          format: "text",
          overrides: createEmptyRunOverrides(),
          extractOnly: false,
          slides: null,
        },
        {
          runId: "cache-test",
          env: { HOME: root, OPENAI_API_KEY: "test" },
          fetch: globalThis.fetch.bind(globalThis),
          execFile: execFile as unknown as ExecFileFn,
          cache: cacheState,
          mediaCache: null,
        },
        (event) => {
          events.push({
            type: event.type,
            ...(event.type === "summary-cache" ? { cached: event.cached } : {}),
          });
          if (event.type === "summary-delta") out += event.text;
        },
      );
      if (result.kind !== "summary") throw new Error("expected summary result");
      return { out, summary: result.summary, metrics: buildDaemonSummaryMetrics(result), events };
    };

    const first = await runOnce();
    expect(mocks.streamSimple).toHaveBeenCalledTimes(1);
    expect(first.out).toBe("### Overview\n- Cached summary.\n");
    expect(first.summary).toBe("### Overview\n- Cached summary.");
    expect(first.events.slice(0, 3)).toEqual([
      { type: "run-started" },
      { type: "content-extracted" },
      { type: "summary-started" },
    ]);
    expect(first.events).toContainEqual({ type: "summary-cache", cached: false });
    expect(first.events.at(-1)).toEqual({ type: "run-completed" });

    const second = await runOnce();
    expect(mocks.streamSimple).toHaveBeenCalledTimes(1);
    expect(second.out).toBe(first.out);
    expect(second.summary).toBe(first.summary);
    expect(second.metrics.summary.split(" · ")[0]).toBe("Cached");
    expect(second.events).toContainEqual({ type: "summary-cache", cached: true });
    expect(second.events.at(-1)).toEqual({ type: "run-completed" });

    store.close();
    globalFetchSpy.mockRestore();
  });
});
