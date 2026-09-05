import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import JSON5 from "json5";
import { describe, expect, it } from "vitest";

const rootPackage = JSON.parse(readFileSync(resolve("package.json"), "utf8")) as {
  scripts: Record<string, string>;
  devDependencies: Record<string, string>;
  engines: Record<string, string>;
  packageManager: string;
};
const corePackage = JSON.parse(readFileSync(resolve("packages/core/package.json"), "utf8")) as {
  scripts: Record<string, string>;
  devDependencies: Record<string, string>;
  engines: Record<string, string>;
  packageManager: string;
};
const releaseScript = readFileSync(resolve("scripts/release.sh"), "utf8");
const registerTypeScript = readFileSync(resolve("scripts/register-typescript.mjs"), "utf8");
const pnpmWorkspace = readFileSync(resolve("pnpm-workspace.yaml"), "utf8");
const pnpmLockfile = readFileSync(resolve("pnpm-lock.yaml"), "utf8");
const testDockerfile = readFileSync(resolve("Dockerfile.test"), "utf8");
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

  it("runs source CLI aliases against core source without rebuilding shared output", () => {
    expect(rootPackage.scripts["dev:cli"]).toBe(
      "node --import ./scripts/register-typescript.mjs src/cli.ts",
    );
    expect(rootPackage.scripts.s).toBe("pnpm dev:cli");
    expect(rootPackage.scripts.summarize).toBe("pnpm dev:cli");
    expect(registerTypeScript).toContain('"packages", "core", "src"');
    expect(registerTypeScript).toContain('"@steipete/summarize-core/"');
  });

  it("uses Node-native TypeScript without tsx or esbuild", () => {
    expect(rootPackage.devDependencies.tsx).toBeUndefined();
    expect(rootPackage.devDependencies.esbuild).toBeUndefined();
    expect(pnpmWorkspace).toContain('"wxt>esbuild": "-"');
    expect(pnpmWorkspace).toContain('"vite>esbuild": "-"');
    expect(pnpmWorkspace).toContain('"vite>tsx": "-"');
    expect(pnpmLockfile).not.toMatch(/^\s{2}(?:esbuild|tsx)@/mu);
  });

  it("typechecks all workspace layers from the root script", () => {
    expect(rootPackage.scripts.typecheck).toBe(
      "pnpm -C packages/core typecheck && tsc -p tsconfig.build.json --noEmit && pnpm -C apps/chrome-extension typecheck",
    );
    expect(corePackage.scripts.typecheck).toBe("tsc -p tsconfig.build.json --noEmit");
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

  it("keeps the test container and core package aligned with the root runtime and toolchain", () => {
    const imageNodeMajor = testDockerfile.match(/^FROM node:(\d+)-/mu)?.[1];
    expect(Number(imageNodeMajor)).toBe(majorFromRange(rootPackage.engines.node));
    expect(corePackage.packageManager).toBe(rootPackage.packageManager);
  });
});
