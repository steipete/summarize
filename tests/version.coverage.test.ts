import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  FALLBACK_VERSION,
  formatVersionLine,
  resolveGitSha,
  resolvePackageVersion,
} from "../src/version.js";

const roots: string[] = [];
const originalVersion = process.env.SUMMARIZE_VERSION;
const originalSha = process.env.SUMMARIZE_GIT_SHA;

function makeRoot(prefix: string) {
  const root = join(tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(root, { recursive: true });
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  if (originalVersion === undefined) delete process.env.SUMMARIZE_VERSION;
  else process.env.SUMMARIZE_VERSION = originalVersion;
  if (originalSha === undefined) delete process.env.SUMMARIZE_GIT_SHA;
  else process.env.SUMMARIZE_GIT_SHA = originalSha;
});

describe("version resolution coverage", () => {
  it("resolves package and Git metadata without an import URL", () => {
    process.env.SUMMARIZE_VERSION = " ";
    process.env.SUMMARIZE_GIT_SHA = " ";
    const root = makeRoot("summarize-version-cwd");
    mkdirSync(join(root, ".git"));
    writeFileSync(join(root, "package.json"), JSON.stringify({ version: FALLBACK_VERSION }));
    writeFileSync(join(root, ".git", "HEAD"), "1234567890abcdef\n");
    const moduleUrl = new URL("../src/version.ts", import.meta.url).href;
    // Native ESM has no __dirname, unlike Vitest's module wrapper.
    const output = execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        `import { resolvePackageVersion, resolveGitSha } from ${JSON.stringify(moduleUrl)};
         console.log(JSON.stringify([resolvePackageVersion(), resolveGitSha()]));`,
      ],
      { cwd: root, env: process.env, encoding: "utf8" },
    );
    expect(JSON.parse(output)).toEqual([FALLBACK_VERSION, "12345678"]);
  });

  it("handles injected, nested, invalid, and fallback package versions", () => {
    process.env.SUMMARIZE_VERSION = " 1.2.3 ";
    expect(resolvePackageVersion()).toBe("1.2.3");
    process.env.SUMMARIZE_VERSION = " ";

    const root = makeRoot("summarize-version");
    const nested = join(root, "a", "b");
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(root, "package.json"), '{"version":" 2.3.4 "}');
    expect(resolvePackageVersion(pathToFileURL(join(nested, "module.js")).href)).toBe("2.3.4");

    writeFileSync(join(root, "package.json"), '{"version":1}');
    expect(resolvePackageVersion(pathToFileURL(join(nested, "module.js")).href)).toBe(
      FALLBACK_VERSION,
    );
    writeFileSync(join(root, "package.json"), '{"version":"   "}');
    expect(resolvePackageVersion(pathToFileURL(join(nested, "module.js")).href)).toBe(
      FALLBACK_VERSION,
    );
    writeFileSync(join(root, "package.json"), "{bad");
    expect(resolvePackageVersion(pathToFileURL(join(nested, "module.js")).href)).toBe(
      FALLBACK_VERSION,
    );
  });

  it("handles injected and detached Git SHAs", () => {
    process.env.SUMMARIZE_GIT_SHA = " abcdef123456 ";
    expect(resolveGitSha()).toBe("abcdef12");
    process.env.SUMMARIZE_GIT_SHA = " short ";
    expect(resolveGitSha()).toBe("short");
    process.env.SUMMARIZE_GIT_SHA = " ";

    const root = makeRoot("summarize-git-detached");
    const moduleDir = join(root, "dist");
    mkdirSync(join(root, ".git"), { recursive: true });
    mkdirSync(moduleDir, { recursive: true });
    writeFileSync(join(root, "package.json"), '{"version":"1.0.0"}');
    writeFileSync(join(root, ".git", "HEAD"), "1234567890abcdef\n");
    const url = pathToFileURL(join(moduleDir, "module.js")).href;
    expect(resolveGitSha(url)).toBe("12345678");
    expect(formatVersionLine(url)).toBe("1.0.0 (12345678)");

    writeFileSync(join(root, ".git", "HEAD"), "\n");
    expect(resolveGitSha(url)).toBeNull();
  });

  it("resolves direct and packed refs plus relative gitdir files", () => {
    process.env.SUMMARIZE_GIT_SHA = " ";
    const root = makeRoot("summarize-git-refs");
    const checkout = join(root, "checkout");
    const gitDir = join(root, "actual.git");
    const moduleDir = join(checkout, "dist");
    mkdirSync(moduleDir, { recursive: true });
    mkdirSync(join(gitDir, "refs", "heads"), { recursive: true });
    writeFileSync(join(checkout, "package.json"), '{"version":"1.0.0"}');
    writeFileSync(join(checkout, ".git"), "gitdir: ../actual.git\n");
    writeFileSync(join(gitDir, "HEAD"), "ref: refs/heads/main\n");
    writeFileSync(join(gitDir, "refs", "heads", "main"), "abcdef1234567890\n");
    const url = pathToFileURL(join(moduleDir, "module.js")).href;
    expect(resolveGitSha(url)).toBe("abcdef12");

    rmSync(join(gitDir, "refs"), { recursive: true, force: true });
    writeFileSync(
      join(gitDir, "packed-refs"),
      "# pack\n^peeled\n1234567890abcdef refs/heads/other\nfedcba9876543210 refs/heads/main\n",
    );
    expect(resolveGitSha(url)).toBe("fedcba98");

    mkdirSync(join(gitDir, "refs", "heads"), { recursive: true });
    writeFileSync(join(gitDir, "refs", "heads", "main"), "   \n");
    writeFileSync(join(gitDir, "packed-refs"), " refs/heads/main\n");
    expect(resolveGitSha(url)).toBeNull();

    writeFileSync(join(gitDir, "HEAD"), "ref: \n");
    expect(resolveGitSha(url)).toBeNull();
    writeFileSync(join(checkout, ".git"), "not a gitdir\n");
    expect(resolveGitSha(url)).toBeNull();
  });

  it("resolves refs from common dirs and tolerates malformed metadata", () => {
    process.env.SUMMARIZE_GIT_SHA = " ";
    const root = makeRoot("summarize-git-common");
    const checkout = join(root, "checkout");
    const gitDir = join(root, "repo", ".git", "worktrees", "checkout");
    const commonDir = join(root, "repo", ".git");
    const moduleDir = join(checkout, "dist");
    mkdirSync(moduleDir, { recursive: true });
    mkdirSync(gitDir, { recursive: true });
    writeFileSync(join(checkout, "package.json"), '{"version":"1.0.0"}');
    writeFileSync(join(checkout, ".git"), `gitdir: ${gitDir}\n`);
    writeFileSync(join(gitDir, "HEAD"), "ref: refs/heads/main\n");
    writeFileSync(join(gitDir, "commondir"), `${commonDir}\n`);
    writeFileSync(join(commonDir, "packed-refs"), "abcdef1234567890 refs/heads/main\n");
    expect(resolveGitSha(pathToFileURL(join(moduleDir, "module.js")).href)).toBe("abcdef12");

    writeFileSync(join(gitDir, "commondir"), "../..\n");
    expect(resolveGitSha(pathToFileURL(join(moduleDir, "module.js")).href)).toBe("abcdef12");

    writeFileSync(join(gitDir, "commondir"), "\n");
    writeFileSync(join(gitDir, "HEAD"), "ref: refs/heads/missing\n");
    expect(resolveGitSha(pathToFileURL(join(moduleDir, "module.js")).href)).toBeNull();
  });
});
