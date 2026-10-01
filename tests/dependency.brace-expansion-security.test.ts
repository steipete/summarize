import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const extensionRequire = createRequire(resolve("apps/chrome-extension/package.json"));
const webExtRequire = createRequire(extensionRequire.resolve("web-ext"));
const multimatchRequire = createRequire(webExtRequire.resolve("multimatch"));
const minimatchRequire = createRequire(multimatchRequire.resolve("minimatch"));
const expansionPath = minimatchRequire.resolve("brace-expansion");

describe("brace-expansion dependency security", () => {
  it.each([
    ["many comma groups", "'{' + '{a},'.repeat(8_000) + 'b}'"],
    ["wide comma groups", "'{{x},' + 'a,'.repeat(130_000) + 'b}'"],
    ["deeply nested groups", "'{'.repeat(4_000) + 'a,b' + '}'.repeat(4_000)"],
    ["repeated closing-brace rewrites", "'{a}' + '}'.repeat(128_000) + ',z}'"],
  ])("bounds parsing of %s", (_name, input) => {
    const probe = `
      const assert = require("node:assert/strict");
      const expand = require(process.argv[1]);
      assert.deepEqual(expand("image-{1..3}.{png,jpg}"), [
        "image-1.png", "image-1.jpg", "image-2.png", "image-2.jpg", "image-3.png", "image-3.jpg",
      ]);
      assert(Array.isArray(expand(${input}, { max: 1, maxLength: 1 })));
    `;
    expect(() =>
      execFileSync(process.execPath, ["--eval", probe, expansionPath], {
        stdio: "pipe",
        timeout: 5_000,
      }),
    ).not.toThrow();
  });
});
