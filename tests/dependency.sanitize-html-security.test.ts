import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { expect, it } from "vitest";

const coreRequire = createRequire(resolve("packages/core/package.json"));

it("bounds discarded iframe recursion and preserves the overall nesting limit", () => {
  const result = spawnSync(
    process.execPath,
    [
      "-e",
      String.raw`
const assert = require("node:assert/strict");
const sanitizeHtml = require(process.argv[1]);
sanitizeHtml("<iframe>".repeat(20000));
const nested = ("<iframe>" + "<b>".repeat(3)).repeat(50) + "text";
const output = sanitizeHtml(nested, { allowedTags: ["b"], nestingLimit: 3 });
let depth = 0;
for (const [tag] of output.matchAll(/<\/?b>/g)) {
  depth += tag === "<b>" ? 1 : -1;
  assert.ok(depth <= 3, "iframe fallback bypassed nestingLimit");
}
assert.equal(sanitizeHtml("<p>Safe <b>text</b></p>"), "<p>Safe <b>text</b></p>");
`,
      coreRequire.resolve("sanitize-html"),
    ],
    { encoding: "utf8", timeout: 5_000 },
  );
  expect(result.error).toBeUndefined();
  expect(result.stderr).toBe("");
  expect(result.status).toBe(0);
});
