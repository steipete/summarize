import { describe, expect, it } from "vitest";
import {
  parseApiKeysConfig,
  parseCacheConfig,
  parseCliConfig,
  parseEnvConfig,
  parseLoggingConfig,
  parseMediaConfig,
  parseOpenAiConfig,
  parseOutputConfig,
  parseProviderBaseUrlConfig,
  parseSlidesConfig,
  parseUiConfig,
} from "../src/config/sections.js";

const path = "/tmp/config.json";

function expectInvalid(run: () => unknown, fragment: string) {
  expect(run).toThrow(fragment);
}

describe("config section parser coverage", () => {
  it("parses provider, cache, media, and slide sections", () => {
    expect(parseProviderBaseUrlConfig(undefined, path, "openai")).toBeUndefined();
    expect(parseProviderBaseUrlConfig({}, path, "openai")).toBeUndefined();
    expect(
      parseProviderBaseUrlConfig({ baseUrl: "https://api.example.test/v1/" }, path, "openai"),
    ).toEqual({ baseUrl: "https://api.example.test/v1/" });

    expect(parseCacheConfig({}, path)).toBeUndefined();
    expect(parseCacheConfig({ cache: {} }, path)).toBeUndefined();
    expect(parseCacheConfig({ cache: { enabled: false } }, path)).toEqual({ enabled: false });
    expect(parseCacheConfig({ cache: { media: { enabled: false } } }, path)).toEqual({
      media: { enabled: false },
    });
    expect(
      parseCacheConfig(
        {
          cache: {
            enabled: false,
            maxMb: 12,
            ttlDays: 3,
            path: " /tmp/cache ",
            media: {
              enabled: false,
              maxMb: 24,
              ttlDays: 4,
              path: " /tmp/media ",
              verify: " HASH ",
            },
          },
        },
        path,
      ),
    ).toEqual({
      enabled: false,
      maxMb: 12,
      ttlDays: 3,
      path: "/tmp/cache",
      media: {
        enabled: false,
        maxMb: 24,
        ttlDays: 4,
        path: "/tmp/media",
        verify: "hash",
      },
    });

    expect(parseMediaConfig({})).toBeUndefined();
    expect(parseMediaConfig({ media: "bad" })).toBeUndefined();
    expect(parseMediaConfig({ media: {} })).toBeUndefined();
    expect(parseMediaConfig({ media: { videoMode: "understand", embeddedVideo: "both" } })).toEqual(
      {
        videoMode: "understand",
        embeddedVideo: "both",
      },
    );
    expect(parseMediaConfig({ media: { videoMode: "bad", embeddedVideo: "bad" } })).toBeUndefined();

    expect(parseSlidesConfig({}, path)).toBeUndefined();
    expect(parseSlidesConfig({ slides: {} }, path)).toBeUndefined();
    expect(parseSlidesConfig({ slides: { enabled: false } }, path)).toEqual({ enabled: false });
    expect(
      parseSlidesConfig(
        {
          slides: {
            enabled: false,
            ocr: false,
            dir: " /tmp/slides ",
            sceneThreshold: 0.5,
            max: 20,
            minDuration: 0,
          },
        },
        path,
      ),
    ).toEqual({
      enabled: false,
      ocr: false,
      dir: "/tmp/slides",
      sceneThreshold: 0.5,
      max: 20,
      minDuration: 0,
    });
  });

  it("rejects malformed cache and slide fields", () => {
    expectInvalid(() => parseProviderBaseUrlConfig("bad", path, "openai"), "must be an object");
    expectInvalid(() => parseCacheConfig({ cache: "bad" }, path), '"cache" must be an object');
    for (const [field, value] of [
      ["maxMb", 0],
      ["ttlDays", Number.NaN],
      ["path", ""],
    ] as const) {
      expectInvalid(() => parseCacheConfig({ cache: { [field]: value } }, path), `cache.${field}`);
    }
    expectInvalid(() => parseCacheConfig({ cache: { media: "bad" } }, path), "cache.media");
    for (const [field, value] of [
      ["maxMb", -1],
      ["ttlDays", 0],
      ["path", 2],
      ["verify", "fast"],
    ] as const) {
      expectInvalid(
        () => parseCacheConfig({ cache: { media: { [field]: value } } }, path),
        `cache.media.${field}`,
      );
    }

    expectInvalid(() => parseSlidesConfig({ slides: "bad" }, path), "slides");
    for (const [field, value] of [
      ["dir", ""],
      ["sceneThreshold", 0.01],
      ["sceneThreshold", Number.NaN],
      ["max", 1.5],
      ["max", 0],
      ["minDuration", -1],
    ] as const) {
      expectInvalid(
        () => parseSlidesConfig({ slides: { [field]: value } }, path),
        `slides.${field}`,
      );
    }
  });

  it("parses every CLI provider and fallback option", () => {
    expect(parseCliConfig({}, path)).toBeUndefined();
    expect(parseCliConfig({ cli: "bad" }, path)).toBeUndefined();
    expect(parseCliConfig({ cli: {} }, path)).toBeUndefined();

    const provider = {
      binary: " tool ",
      model: " model ",
      extraArgs: ["--one", "two"],
      isolated: false,
    };
    expect(
      parseCliConfig(
        {
          cli: {
            enabled: ["claude", "claude", "codex"],
            claude: provider,
            codex: provider,
            gemini: provider,
            agent: provider,
            openclaw: provider,
            opencode: provider,
            copilot: provider,
            agy: provider,
            pi: provider,
            devin: provider,
            autoFallback: {
              enabled: false,
              onlyWhenNoApiKeys: false,
              order: ["pi", "codex", "pi"],
            },
            promptOverride: " custom ",
            allowTools: false,
            cwd: " /tmp/work ",
            extraArgs: ["--global"],
          },
        },
        path,
      ),
    ).toMatchObject({
      enabled: ["claude", "codex"],
      claude: { binary: "tool", model: "model", extraArgs: ["--one", "two"], isolated: false },
      codex: { binary: "tool", model: "model", extraArgs: ["--one", "two"], isolated: false },
      devin: { binary: "tool", model: "model", extraArgs: ["--one", "two"], isolated: false },
      autoFallback: { enabled: false, onlyWhenNoApiKeys: false, order: ["pi", "codex"] },
      promptOverride: "custom",
      allowTools: false,
      cwd: "/tmp/work",
      extraArgs: ["--global"],
    });
    expect(parseCliConfig({ cli: { magicAuto: {} } }, path)).toEqual({ autoFallback: {} });
  });

  it("rejects malformed CLI provider and fallback options", () => {
    expectInvalid(() => parseCliConfig({ cli: { disabled: true } }, path), "cli.disabled");
    expectInvalid(() => parseCliConfig({ cli: { enabled: "codex" } }, path), "must be an array");
    expect(parseCliConfig({ cli: { enabled: [] } }, path)).toBeUndefined();
    expectInvalid(() => parseCliConfig({ cli: { claude: "bad" } }, path), "cli.claude");
    expectInvalid(
      () => parseCliConfig({ cli: { claude: { enabled: true } } }, path),
      "not supported",
    );
    expectInvalid(
      () => parseCliConfig({ cli: { claude: { isolated: "yes" } } }, path),
      "must be a boolean",
    );
    expectInvalid(() => parseCliConfig({ cli: { autoFallback: "bad" } }, path), "cli.autoFallback");
    expectInvalid(
      () => parseCliConfig({ cli: { autoFallback: { enabled: "yes" } } }, path),
      "enabled",
    );
    expectInvalid(
      () => parseCliConfig({ cli: { autoFallback: { onlyWhenNoApiKeys: "yes" } } }, path),
      "onlyWhenNoApiKeys",
    );
    expectInvalid(
      () => parseCliConfig({ cli: { autoFallback: { order: "pi" } } }, path),
      "must be an array",
    );
    expectInvalid(
      () => parseCliConfig({ cli: { autoFallback: {}, magicAuto: {} } }, path),
      "only one",
    );
  });

  it("parses output, UI, logging, OpenAI, environment, and API keys", () => {
    expect(parseOutputConfig({}, path)).toBeUndefined();
    expect(parseOutputConfig({ output: {} }, path)).toBeUndefined();
    expect(parseOutputConfig({ output: { language: " English ", length: "long" } }, path)).toEqual({
      language: "English",
      length: "long",
    });

    expect(parseUiConfig({}, path)).toBeUndefined();
    expect(parseUiConfig({ ui: {} }, path)).toBeUndefined();
    expect(parseUiConfig({ ui: { theme: " MONO " } }, path)).toEqual({ theme: "mono" });

    expect(parseLoggingConfig({}, path)).toBeUndefined();
    expect(parseLoggingConfig({ logging: {} }, path)).toBeUndefined();
    expect(parseLoggingConfig({ logging: { enabled: false } }, path)).toEqual({ enabled: false });
    expect(
      parseLoggingConfig(
        {
          logging: {
            enabled: false,
            level: "debug",
            format: "json",
            file: " /tmp/log ",
            maxMb: 5,
            maxFiles: 2.9,
          },
        },
        path,
      ),
    ).toEqual({
      enabled: false,
      level: "debug",
      format: "json",
      file: "/tmp/log",
      maxMb: 5,
      maxFiles: 2,
    });

    expect(parseOpenAiConfig({}, path)).toBeUndefined();
    expect(parseOpenAiConfig({ openai: {} }, path)).toBeUndefined();
    expect(
      parseOpenAiConfig(
        {
          openai: {
            baseUrl: "https://api.example.test/v1/",
            useChatCompletions: false,
            serviceTier: " flex ",
            reasoningEffort: "high",
            thinking: "HIGH",
            textVerbosity: "low",
            whisperUsdPerMinute: 0.01,
          },
        },
        path,
      ),
    ).toEqual({
      baseUrl: "https://api.example.test/v1/",
      useChatCompletions: false,
      serviceTier: "flex",
      reasoningEffort: "high",
      textVerbosity: "low",
      whisperUsdPerMinute: 0.01,
    });
    expect(parseOpenAiConfig({ openai: { thinking: "medium" } }, path)).toEqual({
      reasoningEffort: "medium",
    });

    expect(parseEnvConfig({}, path)).toBeUndefined();
    expect(parseEnvConfig({ env: {} }, path)).toBeUndefined();
    expect(parseEnvConfig({ env: { " KEY ": "value" } }, path)).toEqual({ KEY: "value" });

    expect(parseApiKeysConfig({}, path)).toBeUndefined();
    expect(parseApiKeysConfig({ apiKeys: {} }, path)).toBeUndefined();
    expect(
      parseApiKeysConfig(
        {
          apiKeys: {
            OpenAI: " openai-key ",
            NVIDIA: " nvidia-key ",
            MiniMax: " minimax-key ",
            Anthropic: " anthropic-key ",
            Google: " google-key ",
            XAI: " xai-key ",
            OpenRouter: " openrouter-key ",
            ZAI: " zai-key ",
            Apify: " apify-key ",
            Firecrawl: " firecrawl-key ",
            Fal: " fal-key ",
            Groq: " groq-key ",
            AssemblyAI: " assemblyai-key ",
            ElevenLabs: " elevenlabs-key ",
          },
        },
        path,
      ),
    ).toMatchObject({ openai: "openai-key", elevenlabs: "elevenlabs-key" });
  });

  it("rejects malformed output, UI, logging, OpenAI, environment, and API keys", () => {
    expectInvalid(() => parseOutputConfig({ output: "bad" }, path), "output");
    expectInvalid(() => parseOutputConfig({ output: { length: 1 } }, path), "must be a string");
    expectInvalid(() => parseOutputConfig({ output: { length: " " } }, path), "must not be empty");
    expectInvalid(() => parseOutputConfig({ output: { length: "forever" } }, path), "is invalid");
    expectInvalid(() => parseUiConfig({ ui: "bad" }, path), "ui");
    expectInvalid(() => parseUiConfig({ ui: { theme: "neon" } }, path), "ui.theme");
    expectInvalid(() => parseLoggingConfig({ logging: "bad" }, path), "logging");
    for (const [field, value] of [
      ["file", ""],
      ["maxMb", 0],
      ["maxFiles", Number.NaN],
    ] as const) {
      expectInvalid(
        () => parseLoggingConfig({ logging: { [field]: value } }, path),
        `logging.${field}`,
      );
    }
    expectInvalid(() => parseOpenAiConfig({ openai: "bad" }, path), "openai");
    expectInvalid(
      () => parseOpenAiConfig({ openai: { reasoningEffort: "high", thinking: "low" } }, path),
      "must not conflict",
    );
    expectInvalid(() => parseEnvConfig({ env: "bad" }, path), "env");
    expectInvalid(() => parseEnvConfig({ env: { " ": "x" } }, path), "empty key");
    expectInvalid(() => parseEnvConfig({ env: { KEY: 1 } }, path), "must be a string");
    expectInvalid(() => parseApiKeysConfig({ apiKeys: "bad" }, path), "apiKeys");
    expectInvalid(() => parseApiKeysConfig({ apiKeys: { unknown: "x" } }, path), "unknown");
    expectInvalid(() => parseApiKeysConfig({ apiKeys: { openai: " " } }, path), "non-empty");
  });
});
