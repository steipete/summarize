import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import JSON5 from "json5";
import { describe, expect, it } from "vitest";

const rootPackage = JSON.parse(readFileSync(resolve("package.json"), "utf8")) as {
  scripts: Record<string, string>;
  devDependencies: Record<string, string>;
  engines: Record<string, string>;
};
const corePackage = JSON.parse(readFileSync(resolve("packages/core/package.json"), "utf8")) as {
  devDependencies: Record<string, string>;
  engines: Record<string, string>;
};
const releaseScript = readFileSync(resolve("scripts/release.sh"), "utf8");
const oxfmtConfig = JSON5.parse(readFileSync(resolve(".oxfmtrc.jsonc"), "utf8")) as {
  ignorePatterns?: string[];
};

function majorFromRange(range: string): number {
  const match = range.match(/\d+/u);
  if (!match) throw new Error(`No major version in range: ${range}`);
  return Number(match[0]);
}

describe("package scripts", () => {
  it("keeps the root check gate complete", () => {
    expect(rootPackage.scripts.check).toContain("pnpm format:check");
    expect(rootPackage.scripts.check).toContain("pnpm lint");
    expect(rootPackage.scripts.check).toContain("pnpm typecheck");
    expect(rootPackage.scripts.check).toContain("pnpm test:coverage");
  });

  it("keeps the lint script type-aware", () => {
    expect(rootPackage.scripts.lint).toBe(
      "oxlint --type-aware --tsconfig tsconfig.build.json --config .oxlintrc.json .",
    );
  });

  it("builds core before root library and CLI outputs", () => {
    expect(rootPackage.scripts.build).toBe(
      "pnpm clean && pnpm -C packages/core build && pnpm build:lib && pnpm build:cli",
    );
  });

  it("typechecks both workspace layers from the root script", () => {
    expect(rootPackage.scripts.typecheck).toBe(
      "pnpm -C packages/core typecheck && tsgo -p tsconfig.build.json --noEmit",
    );
  });

  it("runs vitest in non-watch mode from the root test script", () => {
    expect(rootPackage.scripts.test).toBe("vitest run");
  });

  it("keeps formatter checks away from local tool metadata", () => {
    expect(oxfmtConfig.ignorePatterns).toContain(".clawpatch/");
  });

  it("rejects empty release notes before creating GitHub releases", () => {
    expect(releaseScript).toContain("grep -q '[^[:space:]]'");
  });

  it("keeps Node typings aligned with the supported engine floor", () => {
    const rootNodeMajor = majorFromRange(rootPackage.engines.node);
    expect(majorFromRange(rootPackage.devDependencies["@types/node"])).toBe(rootNodeMajor);
    expect(majorFromRange(corePackage.devDependencies["@types/node"])).toBe(rootNodeMajor);
  });
});
