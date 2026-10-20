import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const extensionRequire = createRequire(resolve("apps/chrome-extension/package.json"));
const packageDir = dirname(extensionRequire.resolve("markdown-it/package.json"));

const renderPathologicalMarkdown = `
const { pathToFileURL } = require("node:url");
(async () => {
  const loaded = process.argv[2] === "esm"
    ? await import(pathToFileURL(process.argv[1]).href)
    : require(process.argv[1]);
  const MarkdownIt = loaded.default ?? loaded;
  const markdown = new MarkdownIt({ html: true });
  const inputs = [
    '[a]: /u "' + 'x\\n'.repeat(200000),
    '[' + 'a\\n'.repeat(200000),
    ...['<!--', '<?x', '<!A', '<![CDATA['].map(opener => 'x ' + opener.repeat(100000)),
  ];
  for (const input of inputs) {
    if (!markdown.render(input).length) throw new Error("Missing rendered text");
  }
  const normal = markdown.render('[label][ref]\\n\\n[ref]: /safe "title"\\n');
  if (!normal.includes('<a href="/safe" title="title">label</a>')) {
    throw new Error("Valid reference link changed");
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
`;

describe("patched markdown-it dependency", () => {
  it.each([
    ["esm", "markdown-it.mjs"],
    ["cjs", "markdown-it.cjs.js"],
  ])("bounds unclosed references and inline HTML in %s", (kind, filename) => {
    // A subprocess deadline also contains regressions that block the JS event loop.
    const result = spawnSync(
      process.execPath,
      ["-e", renderPathologicalMarkdown, join(packageDir, "dist", filename), kind],
      { encoding: "utf8", timeout: 5_000 },
    );
    expect(result.error).toBeUndefined();
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
  });
});
