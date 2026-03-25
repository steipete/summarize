import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadSummarizeConfig } from "../src/config.js";

const writeJsonConfig = (value: unknown) => {
  const root = mkdtempSync(join(tmpdir(), "summarize-config-more-"));
  const dir = join(root, ".summarize");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "config.json"), JSON.stringify(value), "utf8");
  return root;
};

describe("config extra branches", () => {
  it("rejects model.id without a provider prefix", () => {
    const root = writeJsonConfig({ model: { id: "gpt-5.2" } });
    expect(() => loadSummarizeConfig({ env: { HOME: root } })).toThrow(
      /must be provider-prefixed/i,
    );
  });

  it('rejects model.name "auto" in object form', () => {
    const root = writeJsonConfig({ model: { name: "auto" } });
    expect(() => loadSummarizeConfig({ env: { HOME: root } })).toThrow(/must not be "auto"/i);
  });

  it("rejects invalid models keys (duplicates, spaces, slashes)", () => {
    const rootDup = writeJsonConfig({
      models: { Fast: { id: "openai/gpt-5.2" }, fast: { id: "openai/gpt-5.2" } },
    });
    expect(() => loadSummarizeConfig({ env: { HOME: rootDup } })).toThrow(/duplicate model name/i);

    const rootSpace = writeJsonConfig({ models: { "my preset": { id: "openai/gpt-5.2" } } });
    expect(() => loadSummarizeConfig({ env: { HOME: rootSpace } })).toThrow(
      /must not contain spaces/i,
    );

    const rootSlash = writeJsonConfig({ models: { "a/b": { id: "openai/gpt-5.2" } } });
    expect(() => loadSummarizeConfig({ env: { HOME: rootSlash } })).toThrow(/must not include/i);
  });

  it("rejects models entries that reference another model by name", () => {
    const root = writeJsonConfig({ models: { fast: { name: "other" } } });
    expect(() => loadSummarizeConfig({ env: { HOME: root } })).toThrow(
      /must not reference another model/i,
    );
  });

  it("rejects cli.disabled and per-provider enabled keys", () => {
    const rootDisabled = writeJsonConfig({ cli: { disabled: true } });
    expect(() => loadSummarizeConfig({ env: { HOME: rootDisabled } })).toThrow(
      /"cli\.disabled" is not supported/i,
    );

    const rootNested = writeJsonConfig({ cli: { claude: { enabled: true } } });
    expect(() => loadSummarizeConfig({ env: { HOME: rootNested } })).toThrow(
      /"cli\.claude\.enabled" is not supported/i,
    );
  });

  it("rejects invalid cli.enabled and cli.extraArgs shapes", () => {
    const rootEnabled = writeJsonConfig({ cli: { enabled: "codex" } });
    expect(() => loadSummarizeConfig({ env: { HOME: rootEnabled } })).toThrow(
      /"cli\.enabled" must be an array/i,
    );

    const rootUnknown = writeJsonConfig({ cli: { enabled: ["nope"] } });
    expect(() => loadSummarizeConfig({ env: { HOME: rootUnknown } })).toThrow(
      /unknown CLI provider/i,
    );

    const rootExtraArgs = writeJsonConfig({ cli: { extraArgs: [1] } });
    expect(() => loadSummarizeConfig({ env: { HOME: rootExtraArgs } })).toThrow(
      /"cli\.extraArgs" must be an array of strings/i,
    );
  });

  it("rejects non-object openai config", () => {
    const root = writeJsonConfig({ openai: 1 });
    expect(() => loadSummarizeConfig({ env: { HOME: root } })).toThrow(
      /"openai" must be an object/i,
    );
  });

  it("rejects non-object output config", () => {
    const root = writeJsonConfig({ output: 1 });
    expect(() => loadSummarizeConfig({ env: { HOME: root } })).toThrow(
      /"output" must be an object/i,
    );
  });

  it("rejects invalid output.length", () => {
    const root = writeJsonConfig({ output: { length: "tiny" } });
    expect(() => loadSummarizeConfig({ env: { HOME: root } })).toThrow(/output\.length/i);
  });

  it("rejects non-object ui config", () => {
    const root = writeJsonConfig({ ui: 1 });
    expect(() => loadSummarizeConfig({ env: { HOME: root } })).toThrow(/"ui" must be an object/i);
  });

  it("rejects invalid ui.theme", () => {
    const root = writeJsonConfig({ ui: { theme: "nope" } });
    expect(() => loadSummarizeConfig({ env: { HOME: root } })).toThrow(/ui\.theme/i);
  });
});
