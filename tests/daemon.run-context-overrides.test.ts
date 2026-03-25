import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { CacheState } from "../src/cache.js";
import { createDaemonUrlFlowContext } from "../src/daemon/flow-context.js";

function makeTempHome(): string {
  return mkdtempSync(join(tmpdir(), "summarize-daemon-home-"));
}

function writeConfig(home: string, config: Record<string, unknown>) {
  const configDir = join(home, ".summarize");
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, "config.json"), JSON.stringify(config), "utf8");
}

describe("daemon/flow-context (overrides)", () => {
  const makeCacheState = (): CacheState => ({
    mode: "bypass",
    store: null,
    ttlMs: 0,
    maxBytes: 0,
    path: null,
  });

  it("defaults to xl + auto language when unset", () => {
    const home = makeTempHome();
    const ctx = createDaemonUrlFlowContext({
      env: { HOME: home },
      fetchImpl: fetch,
      cache: makeCacheState(),
      modelOverride: null,
      promptOverride: null,
      lengthRaw: "",
      languageRaw: "",
      maxExtractCharacters: null,
      runStartedAtMs: Date.now(),
      stdoutSink: { writeChunk: () => {} },
    });

    expect(ctx.flags.lengthArg).toEqual({ kind: "preset", preset: "xl" });
    expect(ctx.flags.outputLanguage).toEqual({ kind: "auto" });
  });

  it("accepts custom length and language overrides", () => {
    const home = makeTempHome();
    writeConfig(home, { output: { language: "de" } });
    const ctx = createDaemonUrlFlowContext({
      env: { HOME: home },
      fetchImpl: fetch,
      cache: makeCacheState(),
      modelOverride: null,
      promptOverride: null,
      lengthRaw: "20k",
      languageRaw: "German",
      maxExtractCharacters: null,
      runStartedAtMs: Date.now(),
      stdoutSink: { writeChunk: () => {} },
    });

    expect(ctx.flags.lengthArg).toEqual({ kind: "chars", maxCharacters: 20000 });
    expect(ctx.flags.outputLanguage.kind).toBe("fixed");
    expect(ctx.flags.outputLanguage.kind === "fixed" ? ctx.flags.outputLanguage.tag : null).toBe(
      "de",
    );
  });

  it("uses config language when request is unset, then prefers request overrides", () => {
    const home = makeTempHome();
    writeConfig(home, { output: { language: "de" } });
    const configCtx = createDaemonUrlFlowContext({
      env: { HOME: home },
      fetchImpl: fetch,
      cache: makeCacheState(),
      modelOverride: null,
      promptOverride: null,
      lengthRaw: "xl",
      languageRaw: "",
      maxExtractCharacters: null,
      runStartedAtMs: Date.now(),
      stdoutSink: { writeChunk: () => {} },
    });
    expect(configCtx.flags.outputLanguage.kind).toBe("fixed");
    expect(
      configCtx.flags.outputLanguage.kind === "fixed" ? configCtx.flags.outputLanguage.tag : null,
    ).toBe("de");

    const requestCtx = createDaemonUrlFlowContext({
      env: { HOME: home },
      fetchImpl: fetch,
      cache: makeCacheState(),
      modelOverride: null,
      promptOverride: null,
      lengthRaw: "xl",
      languageRaw: "English",
      maxExtractCharacters: null,
      runStartedAtMs: Date.now(),
      stdoutSink: { writeChunk: () => {} },
    });
    expect(requestCtx.flags.outputLanguage.kind).toBe("fixed");
    expect(
      requestCtx.flags.outputLanguage.kind === "fixed" ? requestCtx.flags.outputLanguage.tag : null,
    ).toBe("en");
  });

  it("uses config length when request length is unset, then prefers request overrides", () => {
    const home = makeTempHome();
    writeConfig(home, { output: { length: "short" } });

    const configCtx = createDaemonUrlFlowContext({
      env: { HOME: home },
      fetchImpl: fetch,
      cache: makeCacheState(),
      modelOverride: null,
      promptOverride: null,
      lengthRaw: "",
      languageRaw: "auto",
      maxExtractCharacters: null,
      runStartedAtMs: Date.now(),
      stdoutSink: { writeChunk: () => {} },
    });
    expect(configCtx.flags.lengthArg).toEqual({ kind: "preset", preset: "short" });

    const requestCtx = createDaemonUrlFlowContext({
      env: { HOME: home },
      fetchImpl: fetch,
      cache: makeCacheState(),
      modelOverride: null,
      promptOverride: null,
      lengthRaw: "20k",
      languageRaw: "auto",
      maxExtractCharacters: null,
      runStartedAtMs: Date.now(),
      stdoutSink: { writeChunk: () => {} },
    });
    expect(requestCtx.flags.lengthArg).toEqual({ kind: "chars", maxCharacters: 20000 });
  });

  it("applies run overrides for daemon contexts", () => {
    const home = makeTempHome();
    const ctx = createDaemonUrlFlowContext({
      env: { HOME: home },
      fetchImpl: fetch,
      cache: makeCacheState(),
      modelOverride: null,
      promptOverride: null,
      lengthRaw: "xl",
      languageRaw: "auto",
      maxExtractCharacters: null,
      overrides: {
        firecrawlMode: "auto",
        markdownMode: "llm",
        preprocessMode: "always",
        youtubeMode: "no-auto",
        videoMode: "transcript",
        transcriptTimestamps: null,
        forceSummary: null,
        timeoutMs: 45_000,
        retries: 2,
        maxOutputTokensArg: 512,
        transcriber: null,
        autoCliFallbackEnabled: null,
        autoCliOrder: null,
      },
      runStartedAtMs: Date.now(),
      stdoutSink: { writeChunk: () => {} },
    });

    expect(ctx.flags.firecrawlMode).toBe("auto");
    expect(ctx.flags.markdownMode).toBe("llm");
    expect(ctx.flags.preprocessMode).toBe("always");
    expect(ctx.flags.youtubeMode).toBe("no-auto");
    expect(ctx.flags.videoMode).toBe("transcript");
    expect(ctx.flags.timeoutMs).toBe(45_000);
    expect(ctx.flags.retries).toBe(2);
    expect(ctx.flags.maxOutputTokensArg).toBe(512);
  });

  it("defaults markdownMode to readability when format=markdown", () => {
    const home = makeTempHome();
    const ctx = createDaemonUrlFlowContext({
      env: { HOME: home },
      fetchImpl: fetch,
      cache: makeCacheState(),
      modelOverride: null,
      promptOverride: null,
      lengthRaw: "xl",
      languageRaw: "auto",
      maxExtractCharacters: null,
      format: "markdown",
      runStartedAtMs: Date.now(),
      stdoutSink: { writeChunk: () => {} },
    });

    expect(ctx.flags.markdownMode).toBe("readability");
  });

  it("adjusts desired output tokens based on length", () => {
    const home = makeTempHome();
    const shortCtx = createDaemonUrlFlowContext({
      env: { HOME: home },
      fetchImpl: fetch,
      cache: makeCacheState(),
      modelOverride: null,
      promptOverride: null,
      lengthRaw: "short",
      languageRaw: "auto",
      maxExtractCharacters: null,
      runStartedAtMs: Date.now(),
      stdoutSink: { writeChunk: () => {} },
    });
    const xlCtx = createDaemonUrlFlowContext({
      env: { HOME: home },
      fetchImpl: fetch,
      cache: makeCacheState(),
      modelOverride: null,
      promptOverride: null,
      lengthRaw: "xl",
      languageRaw: "auto",
      maxExtractCharacters: null,
      runStartedAtMs: Date.now(),
      stdoutSink: { writeChunk: () => {} },
    });

    const shortTokens = shortCtx.model.desiredOutputTokens;
    const xlTokens = xlCtx.model.desiredOutputTokens;
    if (typeof shortTokens !== "number" || typeof xlTokens !== "number") {
      throw new Error("expected desiredOutputTokens to be a number");
    }
    expect(shortTokens).toBeLessThan(xlTokens);
  });
});
