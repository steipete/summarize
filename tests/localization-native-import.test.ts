import { spawnSync } from "node:child_process";
import { expect, it } from "vitest";

it("loads extension catalogs through Node without a bundler JSON transform", () => {
  const moduleUrl = new URL("../apps/chrome-extension/src/lib/i18n.ts", import.meta.url).href;
  const result = spawnSync(
    process.execPath,
    ["--input-type=module", "--eval", `await import(${JSON.stringify(moduleUrl)})`],
    { encoding: "utf8", timeout: 10_000 },
  );
  expect(result.status, result.stderr).toBe(0);
});
