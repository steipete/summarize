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
  const inputs = {
    title: () => '[a]: /u "' + 'x\\n'.repeat(200000),
    label: () => '[' + 'a\\n'.repeat(200000),
    comment: () => 'x ' + '<!--'.repeat(100000),
    processing: () => 'x ' + '<?x'.repeat(100000),
    declaration: () => 'x ' + '<!A'.repeat(100000),
    cdata: () => 'x ' + '<![CDATA['.repeat(100000),
  };
  if (!markdown.render(inputs[process.argv[3]]()).length) throw new Error("Missing rendered text");
  const normal = markdown.render('[label][ref]\\n\\n[ref]: /safe "title"\\n');
  if (!normal.includes('<a href="/safe" title="title">label</a>')) {
    throw new Error("Valid reference link changed");
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
`;

describe("markdown-it dependency security", () => {
  for (const [kind, filename] of [
    ["esm", "markdown-it.mjs"],
    ["cjs", "markdown-it.cjs.js"],
  ]) {
    it.each(["title", "label", "comment", "processing", "declaration", "cdata"])(
      `bounds unclosed %s input (${kind})`,
      (input) => {
        // Give each attack its own deadline instead of sharing one budget across the batch.
        const result = spawnSync(
          process.execPath,
          ["-e", renderPathologicalMarkdown, join(packageDir, "dist", filename), kind, input],
          { encoding: "utf8", timeout: 5_000 },
        );
        expect(result.error).toBeUndefined();
        expect(result.stderr).toBe("");
        expect(result.status).toBe(0);
      },
    );
  }
});
