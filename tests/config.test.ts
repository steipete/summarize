import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadSummarizeConfig } from "../src/config.js";

const writeConfig = (raw: string) => {
  const root = mkdtempSync(join(tmpdir(), "summarize-config-"));
  const configDir = join(root, ".summarize");
  mkdirSync(configDir, { recursive: true });
  const configPath = join(configDir, "config.json");
  writeFileSync(configPath, raw, "utf8");
  return { root, configPath };
};

const writeJsonConfig = (value: unknown) => writeConfig(JSON.stringify(value));

describe("config loading", () => {
  it("loads ~/.summarize/config.json by default", () => {
    const { root, configPath } = writeJsonConfig({ model: { id: "openai/gpt-5.2" } });

    const result = loadSummarizeConfig({ env: { HOME: root } });
    expect(result.path).toBe(configPath);
    expect(result.config).toEqual({ model: { id: "openai/gpt-5.2" } });
  });

  it("loads auto model rules", () => {
    const { root, configPath } = writeJsonConfig({
      model: {
        mode: "auto",
        rules: [
          { when: ["video"], candidates: ["google/gemini-3-flash-preview"] },
          {
            when: ["youtube", "website"],
            candidates: ["openai/gpt-5-nano", "xai/grok-4-fast-non-reasoning"],
          },
          { candidates: ["openai/gpt-5-nano", "openrouter/openai/gpt-5-nano"] },
        ],
      },
      media: { videoMode: "auto" },
    });

    const result = loadSummarizeConfig({ env: { HOME: root } });
    expect(result.path).toBe(configPath);
    expect(result.config).toEqual({
      model: {
        mode: "auto",
        rules: [
          { when: ["video"], candidates: ["google/gemini-3-flash-preview"] },
          {
            when: ["youtube", "website"],
            candidates: ["openai/gpt-5-nano", "xai/grok-4-fast-non-reasoning"],
          },
          { candidates: ["openai/gpt-5-nano", "openrouter/openai/gpt-5-nano"] },
        ],
      },
      media: { videoMode: "auto" },
    });
  });

  it("supports output.language and output.length", () => {
    const { root } = writeJsonConfig({
      model: { id: "openai/gpt-5-mini" },
      output: { language: "de", length: "long" },
    });

    const result = loadSummarizeConfig({ env: { HOME: root } });
    expect(result.config).toEqual({
      model: { id: "openai/gpt-5-mini" },
      output: { language: "de", length: "long" },
    });
  });

  it("supports ui.theme", () => {
    const { root } = writeJsonConfig({
      model: { id: "openai/gpt-5-mini" },
      ui: { theme: "moss" },
    });

    const result = loadSummarizeConfig({ env: { HOME: root } });
    expect(result.config).toEqual({
      model: { id: "openai/gpt-5-mini" },
      ui: { theme: "moss" },
    });
  });

  it("accepts groq and assemblyai legacy apiKeys", () => {
    const { root } = writeJsonConfig({
      apiKeys: {
        groq: "gsk-test",
        assemblyai: "aai-test",
      },
    });

    const result = loadSummarizeConfig({ env: { HOME: root } });
    expect(result.config?.apiKeys).toEqual({
      groq: "gsk-test",
      assemblyai: "aai-test",
    });
  });

  it('supports model shorthand strings ("auto", preset, provider/model)', () => {
    const { root, configPath } = writeJsonConfig({ model: "auto" });
    expect(loadSummarizeConfig({ env: { HOME: root } }).config).toEqual({
      model: { mode: "auto" },
    });

    writeFileSync(configPath, JSON.stringify({ model: "mybag" }), "utf8");
    expect(loadSummarizeConfig({ env: { HOME: root } }).config).toEqual({
      model: { name: "mybag" },
    });

    writeFileSync(configPath, JSON.stringify({ model: "openai/gpt-5-mini" }), "utf8");
    expect(loadSummarizeConfig({ env: { HOME: root } }).config).toEqual({
      model: { id: "openai/gpt-5-mini" },
    });
  });

  it("returns null config when no config file exists", () => {
    const root = mkdtempSync(join(tmpdir(), "summarize-config-"));
    const result = loadSummarizeConfig({ env: { HOME: root } });
    expect(result.config).toBeNull();
    expect(result.path).toBe(join(root, ".summarize", "config.json"));
  });

  it("rejects JSON with line comments", () => {
    const { root } = writeConfig(`{\n// nope\n"model": "auto"\n}`);
    expect(() => loadSummarizeConfig({ env: { HOME: root } })).toThrow(/comments are not allowed/);
  });

  it("rejects JSON with block comments", () => {
    const { root } = writeConfig(`/* nope */\n{"model": "auto"}`);
    expect(() => loadSummarizeConfig({ env: { HOME: root } })).toThrow(/comments are not allowed/);
  });

  it("allows comment markers inside strings", () => {
    const { root } = writeConfig(`{"model": "openai/gpt-5.2", "url": "http://x"}`);
    expect(loadSummarizeConfig({ env: { HOME: root } }).config).toEqual({
      model: { id: "openai/gpt-5.2" },
    });
  });

  it("rejects invalid JSON", () => {
    const { root } = writeConfig("{");
    expect(() => loadSummarizeConfig({ env: { HOME: root } })).toThrow(/Invalid JSON/);
  });

  it("rejects non-object top-level JSON", () => {
    const { root } = writeConfig("[]");
    expect(() => loadSummarizeConfig({ env: { HOME: root } })).toThrow(/expected an object/);
  });

  it("rejects empty model string", () => {
    const { root } = writeJsonConfig({ model: "   " });
    expect(() => loadSummarizeConfig({ env: { HOME: root } })).toThrow(/model.*must not be empty/);
  });

  it("rejects non-object model config", () => {
    const { root } = writeJsonConfig({ model: 42 });
    expect(() => loadSummarizeConfig({ env: { HOME: root } })).toThrow(/model.*must be an object/);
  });

  it("rejects empty model id", () => {
    const { root } = writeJsonConfig({ model: { id: "  " } });
    expect(() => loadSummarizeConfig({ env: { HOME: root } })).toThrow(
      /model\.id.*must not be empty/,
    );
  });

  it("rejects model configs without id, name, or auto mode", () => {
    const { root } = writeJsonConfig({ model: {} });
    expect(() => loadSummarizeConfig({ env: { HOME: root } })).toThrow(/must include either "id"/);
  });

  it("loads named models", () => {
    const { root } = writeJsonConfig({
      model: "auto",
      models: {
        fast: { id: "openai/gpt-5-mini" },
        or: "openrouter/openai/gpt-5-mini",
      },
    });

    expect(loadSummarizeConfig({ env: { HOME: root } }).config).toEqual({
      model: { mode: "auto" },
      models: {
        fast: { id: "openai/gpt-5-mini" },
        or: { id: "openrouter/openai/gpt-5-mini" },
      },
    });
  });

  it('rejects deprecated "bags" key', () => {
    const { root } = writeJsonConfig({
      bags: { fast: { id: "openai/gpt-5-mini" } },
    });
    expect(() => loadSummarizeConfig({ env: { HOME: root } })).toThrow(
      /bags.*no longer supported/i,
    );
  });

  it('rejects reserved model name "auto"', () => {
    const { root } = writeJsonConfig({
      models: { auto: { id: "openai/gpt-5-mini" } },
    });
    expect(() => loadSummarizeConfig({ env: { HOME: root } })).toThrow(/auto.*reserved/i);
  });

  it("rejects non-array model.rules", () => {
    const { root } = writeJsonConfig({ model: { mode: "auto", rules: {} } });
    expect(() => loadSummarizeConfig({ env: { HOME: root } })).toThrow(
      /model\.rules.*must be an array/,
    );
  });

  it('rejects invalid "when" values', () => {
    const { root: rootNotArray } = writeJsonConfig({
      model: { mode: "auto", rules: [{ when: "video", candidates: ["openai/gpt-5.2"] }] },
    });
    expect(() => loadSummarizeConfig({ env: { HOME: rootNotArray } })).toThrow(
      /when.*must be an array/,
    );

    const { root: rootEmpty } = writeJsonConfig({
      model: { mode: "auto", rules: [{ when: [], candidates: ["openai/gpt-5.2"] }] },
    });
    expect(() => loadSummarizeConfig({ env: { HOME: rootEmpty } })).toThrow(/must not be empty/);

    const { root: rootUnknown } = writeJsonConfig({
      model: { mode: "auto", rules: [{ when: ["nope"], candidates: ["openai/gpt-5.2"] }] },
    });
    expect(() => loadSummarizeConfig({ env: { HOME: rootUnknown } })).toThrow(/unknown "when"/);
  });

  it("rejects invalid candidates and bands definitions", () => {
    const { root: rootBoth } = writeJsonConfig({
      model: {
        mode: "auto",
        rules: [
          {
            candidates: ["openai/gpt-5.2"],
            bands: [{ candidates: ["openai/gpt-5.2"] }],
          },
        ],
      },
    });
    expect(() => loadSummarizeConfig({ env: { HOME: rootBoth } })).toThrow(
      /either "candidates" or "bands"/,
    );

    const { root: rootCandidatesNotArray } = writeJsonConfig({
      model: { mode: "auto", rules: [{ candidates: "openai/gpt-5.2" }] },
    });
    expect(() => loadSummarizeConfig({ env: { HOME: rootCandidatesNotArray } })).toThrow(
      /candidates.*array of strings/,
    );

    const { root: rootCandidatesEmpty } = writeJsonConfig({
      model: { mode: "auto", rules: [{ candidates: ["   "] }] },
    });
    expect(() => loadSummarizeConfig({ env: { HOME: rootCandidatesEmpty } })).toThrow(
      /candidates.*must not be empty/,
    );

    const { root: rootBandsEmpty } = writeJsonConfig({
      model: { mode: "auto", rules: [{ bands: [] }] },
    });
    expect(() => loadSummarizeConfig({ env: { HOME: rootBandsEmpty } })).toThrow(
      /bands.*non-empty array/,
    );
  });

  it("rejects invalid token bands", () => {
    const { root: rootBandNotObject } = writeJsonConfig({
      model: { mode: "auto", rules: [{ bands: [1] }] },
    });
    expect(() => loadSummarizeConfig({ env: { HOME: rootBandNotObject } })).toThrow(
      /bands\[\].*must be an object/,
    );

    const { root: rootTokenNotObject } = writeJsonConfig({
      model: { mode: "auto", rules: [{ bands: [{ candidates: ["openai/gpt-5.2"], token: "x" }] }] },
    });
    expect(() => loadSummarizeConfig({ env: { HOME: rootTokenNotObject } })).toThrow(
      /bands\[\]\.token.*must be an object/,
    );

    const { root: rootMinInvalid } = writeJsonConfig({
      model: {
        mode: "auto",
        rules: [{ bands: [{ candidates: ["openai/gpt-5.2"], token: { min: -1 } }] }],
      },
    });
    expect(() => loadSummarizeConfig({ env: { HOME: rootMinInvalid } })).toThrow(
      /token\.min.*>= 0/,
    );

    const { root: rootMaxInvalid } = writeJsonConfig({
      model: {
        mode: "auto",
        rules: [{ bands: [{ candidates: ["openai/gpt-5.2"], token: { max: -1 } }] }],
      },
    });
    expect(() => loadSummarizeConfig({ env: { HOME: rootMaxInvalid } })).toThrow(
      /token\.max.*>= 0/,
    );

    const { root: rootMinMax } = writeJsonConfig({
      model: {
        mode: "auto",
        rules: [{ bands: [{ candidates: ["openai/gpt-5.2"], token: { min: 10, max: 2 } }] }],
      },
    });
    expect(() => loadSummarizeConfig({ env: { HOME: rootMinMax } })).toThrow(/min.*<=.*max/);
  });

  it("rejects rules without candidates or bands", () => {
    const { root } = writeJsonConfig({ model: { mode: "auto", rules: [{}] } });
    expect(() => loadSummarizeConfig({ env: { HOME: root } })).toThrow(
      /must include "candidates" or "bands"/,
    );
  });

  it("parses token bands and ignores invalid media values", () => {
    const { root } = writeJsonConfig({
      model: {
        mode: "auto",
        rules: [
          {
            bands: [
              { candidates: ["openai/gpt-5.2"], token: { min: 100 } },
              { candidates: ["openai/gpt-5.2"], token: { max: 200 } },
              { candidates: ["openai/gpt-5.2"], token: {} },
            ],
          },
        ],
      },
      media: { videoMode: "nope" },
    });
    expect(loadSummarizeConfig({ env: { HOME: root } }).config).toEqual({
      model: {
        mode: "auto",
        rules: [
          {
            bands: [
              { candidates: ["openai/gpt-5.2"], token: { min: 100 } },
              { candidates: ["openai/gpt-5.2"], token: { max: 200 } },
              { candidates: ["openai/gpt-5.2"] },
            ],
          },
        ],
      },
    });
  });

  it("parses cli config overrides", () => {
    const { root } = writeJsonConfig({
      cli: {
        enabled: ["claude", "gemini"],
        claude: {
          binary: "/opt/claude",
          model: "sonnet",
          extraArgs: ["--foo"],
        },
        codex: {
          binary: "codex",
        },
        promptOverride: "Summarize this.",
        allowTools: true,
        cwd: "/tmp",
        extraArgs: ["--bar"],
      },
    });
    expect(loadSummarizeConfig({ env: { HOME: root } }).config).toEqual({
      cli: {
        enabled: ["claude", "gemini"],
        claude: {
          binary: "/opt/claude",
          model: "sonnet",
          extraArgs: ["--foo"],
        },
        codex: { binary: "codex" },
        promptOverride: "Summarize this.",
        allowTools: true,
        cwd: "/tmp",
        extraArgs: ["--bar"],
      },
    });
  });

  it("parses cache config", () => {
    const { root } = writeJsonConfig({
      cache: {
        enabled: false,
        maxMb: 256,
        ttlDays: 14,
        path: "/tmp/summarize-cache.sqlite",
      },
    });
    expect(loadSummarizeConfig({ env: { HOME: root } }).config).toEqual({
      cache: {
        enabled: false,
        maxMb: 256,
        ttlDays: 14,
        path: "/tmp/summarize-cache.sqlite",
      },
    });
  });

  it("parses cache media config", () => {
    const { root } = writeJsonConfig({
      cache: {
        media: {
          enabled: true,
          maxMb: 512,
          ttlDays: 3,
          path: "/tmp/summarize-media",
          verify: "hash",
        },
      },
    });
    expect(loadSummarizeConfig({ env: { HOME: root } }).config).toEqual({
      cache: {
        media: {
          enabled: true,
          maxMb: 512,
          ttlDays: 3,
          path: "/tmp/summarize-media",
          verify: "hash",
        },
      },
    });
  });

  it("rejects invalid cache media settings", () => {
    const { root: badMedia } = writeJsonConfig({ cache: { media: "nope" } });
    expect(() => loadSummarizeConfig({ env: { HOME: badMedia } })).toThrow(/cache\.media/);

    const { root: badMax } = writeJsonConfig({ cache: { media: { maxMb: "nope" } } });
    expect(() => loadSummarizeConfig({ env: { HOME: badMax } })).toThrow(/cache\.media\.maxMb/);

    const { root: badTtl } = writeJsonConfig({ cache: { media: { ttlDays: "nope" } } });
    expect(() => loadSummarizeConfig({ env: { HOME: badTtl } })).toThrow(/cache\.media\.ttlDays/);

    const { root: badPath } = writeJsonConfig({ cache: { media: { path: 123 } } });
    expect(() => loadSummarizeConfig({ env: { HOME: badPath } })).toThrow(/cache\.media\.path/);

    const { root: badVerify } = writeJsonConfig({ cache: { media: { verify: "nope" } } });
    expect(() => loadSummarizeConfig({ env: { HOME: badVerify } })).toThrow(/cache\.media\.verify/);
  });

  it("parses slides config", () => {
    const { root } = writeJsonConfig({
      slides: {
        enabled: true,
        ocr: false,
        dir: "/tmp/slides",
        sceneThreshold: 0.5,
        max: 12,
        minDuration: 1.5,
      },
    });
    expect(loadSummarizeConfig({ env: { HOME: root } }).config).toEqual({
      slides: {
        enabled: true,
        ocr: false,
        dir: "/tmp/slides",
        sceneThreshold: 0.5,
        max: 12,
        minDuration: 1.5,
      },
    });
  });

  it("rejects invalid slides config", () => {
    const { root: badSlides } = writeJsonConfig({ slides: "nope" });
    expect(() => loadSummarizeConfig({ env: { HOME: badSlides } })).toThrow(
      /"slides" must be an object/,
    );

    const { root: badDir } = writeJsonConfig({ slides: { dir: 123 } });
    expect(() => loadSummarizeConfig({ env: { HOME: badDir } })).toThrow(/slides\.dir/);

    const { root: badScene } = writeJsonConfig({ slides: { sceneThreshold: 2 } });
    expect(() => loadSummarizeConfig({ env: { HOME: badScene } })).toThrow(
      /slides\.sceneThreshold/,
    );

    const { root: badMax } = writeJsonConfig({ slides: { max: 1.2 } });
    expect(() => loadSummarizeConfig({ env: { HOME: badMax } })).toThrow(/slides\.max/);

    const { root: badMin } = writeJsonConfig({ slides: { minDuration: -1 } });
    expect(() => loadSummarizeConfig({ env: { HOME: badMin } })).toThrow(/slides\.minDuration/);
  });

  it("rejects invalid cli enabled providers", () => {
    const { root } = writeJsonConfig({ cli: { enabled: ["nope"] } });
    expect(() => loadSummarizeConfig({ env: { HOME: root } })).toThrow(/unknown CLI provider/);
  });

  it("rejects cli disabled and provider enabled flags", () => {
    const { root } = writeJsonConfig({ cli: { disabled: ["claude"] } });
    expect(() => loadSummarizeConfig({ env: { HOME: root } })).toThrow(/cli\.disabled/);

    const { root: rootProvider } = writeJsonConfig({ cli: { claude: { enabled: true } } });
    expect(() => loadSummarizeConfig({ env: { HOME: rootProvider } })).toThrow(
      /cli\.claude\.enabled/,
    );
  });

  it("rejects invalid cli extraArgs", () => {
    const { root: rootTop } = writeJsonConfig({ cli: { extraArgs: "nope" } });
    expect(() => loadSummarizeConfig({ env: { HOME: rootTop } })).toThrow(/cli\.extraArgs/);

    const { root: rootProvider } = writeJsonConfig({
      cli: { gemini: { extraArgs: "nope" } },
    });
    expect(() => loadSummarizeConfig({ env: { HOME: rootProvider } })).toThrow(
      /cli\.gemini\.extraArgs/,
    );
  });

  it("parses openai.useChatCompletions", () => {
    const { root } = writeJsonConfig({
      model: { id: "openai/gpt-5.2" },
      openai: { useChatCompletions: true },
    });
    const result = loadSummarizeConfig({ env: { HOME: root } });
    expect(result.config).toEqual({
      model: { id: "openai/gpt-5.2" },
      openai: { useChatCompletions: true },
    });
  });

  it("parses provider baseUrl config sections", () => {
    const { root } = writeJsonConfig({
      model: { id: "openai/gpt-5.2" },
      openai: { baseUrl: "https://openai-proxy.example.com/v1" },
      anthropic: { baseUrl: "https://anthropic-proxy.example.com" },
      google: { baseUrl: "https://google-proxy.example.com" },
      xai: { baseUrl: "https://xai-proxy.example.com" },
      zai: { baseUrl: "https://api.zhipuai.cn/paas/v4" },
    });
    const result = loadSummarizeConfig({ env: { HOME: root } });
    expect(result.config).toEqual({
      model: { id: "openai/gpt-5.2" },
      openai: { baseUrl: "https://openai-proxy.example.com/v1" },
      anthropic: { baseUrl: "https://anthropic-proxy.example.com" },
      google: { baseUrl: "https://google-proxy.example.com" },
      xai: { baseUrl: "https://xai-proxy.example.com" },
      zai: { baseUrl: "https://api.zhipuai.cn/paas/v4" },
    });
  });

  it("rejects non-object provider baseUrl sections", () => {
    const { root } = writeJsonConfig({ anthropic: "nope" });
    expect(() => loadSummarizeConfig({ env: { HOME: root } })).toThrow(
      /"anthropic" must be an object/i,
    );

    const { root: root2 } = writeJsonConfig({ google: 123 });
    expect(() => loadSummarizeConfig({ env: { HOME: root2 } })).toThrow(
      /"google" must be an object/i,
    );

    const { root: root3 } = writeJsonConfig({ xai: [] });
    expect(() => loadSummarizeConfig({ env: { HOME: root3 } })).toThrow(/"xai" must be an object/i);

    const { root: root4 } = writeJsonConfig({ zai: 123 });
    expect(() => loadSummarizeConfig({ env: { HOME: root4 } })).toThrow(/"zai" must be an object/i);
  });

  it("trims provider baseUrl strings and ignores empty strings", () => {
    const { root } = writeJsonConfig({
      openai: { baseUrl: "  https://example.com/v1  " },
      anthropic: { baseUrl: "   " },
      zai: { baseUrl: "  https://api.zhipuai.cn/paas/v4  " },
    });
    const result = loadSummarizeConfig({ env: { HOME: root } });
    expect(result.config).toEqual({
      openai: { baseUrl: "https://example.com/v1" },
      zai: { baseUrl: "https://api.zhipuai.cn/paas/v4" },
    });
  });
});
