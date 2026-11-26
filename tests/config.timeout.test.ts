import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadSummarizeConfig } from "../src/config.js";
import { resolveRunnerFlags } from "../src/run/runner-flags.js";

function makeHome(config: unknown): string {
  const home = mkdtempSync(join(tmpdir(), "summarize-timeout-config-"));
  mkdirSync(join(home, ".summarize"), { recursive: true });
  writeFileSync(join(home, ".summarize", "config.json"), JSON.stringify(config), "utf8");
  return home;
}

const defaultProgramOpts = {
  cache: true,
  debug: false,
  diarize: undefined,
  extract: false,
  extractOnly: false,
  firecrawl: "auto",
  forceSummary: false,
  format: "text",
  json: false,
  length: "long",
  markdown: undefined,
  markdownMode: undefined,
  maxExtractCharacters: undefined,
  maxOutputTokens: undefined,
  mediaCache: true,
  metrics: "off",
  plain: false,
  preprocess: "auto",
  rememberSpeakers: false,
  retries: "1",
  slidesDebug: false,
  speakerAt: [],
  speakerProfile: undefined,
  stream: "auto",
  timeout: "2m",
  transcriber: "auto",
  verbose: false,
  youtube: "auto",
};

function resolveTimeoutMs(args: { argv: string[]; home: string; timeoutOpt?: string }): number {
  const resolution = resolveRunnerFlags({
    normalizedArgv: args.argv,
    programOpts: { ...defaultProgramOpts, timeout: args.timeoutOpt ?? defaultProgramOpts.timeout },
    envForRun: { HOME: args.home },
    url: "https://example.com",
  });
  return resolution.timeoutMs;
}

describe("config timeout", () => {
  it("reads a valid timeout from config.json", () => {
    const home = makeHome({ timeout: "5m" });
    const { config } = loadSummarizeConfig({ env: { HOME: home } });
    expect(config?.timeout).toBe("5m");
  });

  it("rejects a timeout that is not a string", () => {
    const home = makeHome({ timeout: 300 });
    expect(() => loadSummarizeConfig({ env: { HOME: home } })).toThrow(/timeout/);
  });

  it("rejects an empty or unparsable timeout", () => {
    expect(() => loadSummarizeConfig({ env: { HOME: makeHome({ timeout: "  " }) } })).toThrow(
      /"timeout" must not be empty/,
    );
    expect(() => loadSummarizeConfig({ env: { HOME: makeHome({ timeout: "soon" }) } })).toThrow(
      /"timeout" must be a duration such as 30s, 2m or 5000ms \(got soon\)/,
    );
  });

  it("uses the config timeout when --timeout is absent", () => {
    const home = makeHome({ timeout: "5m" });
    expect(resolveTimeoutMs({ argv: ["summarize", "https://example.com"], home })).toBe(300_000);
  });

  it("lets the --timeout flag override the config timeout", () => {
    const home = makeHome({ timeout: "5m" });
    expect(
      resolveTimeoutMs({
        argv: ["summarize", "https://example.com", "--timeout", "15s"],
        home,
        timeoutOpt: "15s",
      }),
    ).toBe(15_000);
    expect(
      resolveTimeoutMs({
        argv: ["summarize", "https://example.com", "--timeout=45s"],
        home,
        timeoutOpt: "45s",
      }),
    ).toBe(45_000);
  });

  it("falls back to the 2m default when neither the flag nor config sets a timeout", () => {
    const home = makeHome({ model: { id: "openai/gpt-5-mini" } });
    expect(resolveTimeoutMs({ argv: ["summarize", "https://example.com"], home })).toBe(120_000);
  });
});
