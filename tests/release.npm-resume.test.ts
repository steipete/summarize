import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const releaseScript = fileURLToPath(new URL("../scripts/release.sh", import.meta.url));

describe.skipIf(process.platform === "win32")("npm partial publish recovery", () => {
  it.each(["matching core", "different core", "missing core", "existing CLI"])(
    "handles %s without republishing immutable versions",
    (scenario) => {
      const root = mkdtempSync(join(tmpdir(), "summarize-release-resume-"));
      try {
        const bin = join(root, "bin");
        const log = join(root, "calls.jsonl");
        mkdirSync(bin);
        mkdirSync(join(root, "packages/core"), { recursive: true });
        for (const file of ["package.json", "packages/core/package.json"])
          writeFileSync(join(root, file), JSON.stringify({ version: "0.0.0" }));
        const coreBytes = "verified synthetic core tarball";
        writeFileSync(join(root, "core.tgz"), coreBytes);
        const integrity = `sha512-${createHash("sha512").update(coreBytes).digest("base64")}`;
        writeFileSync(join(bin, "git"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
        for (const name of ["npm", "pnpm"])
          writeFileSync(
            join(bin, name),
            `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.CALL_LOG, JSON.stringify({name: ${JSON.stringify(name)}, args}) + "\\n");
if (args[0] === "view") {
  if (args[1] === "@steipete/summarize@0.0.0") process.exit(process.env.SCENARIO === "existing CLI" ? 0 : 1);
  if (process.env.SCENARIO === "missing core") process.exit(1);
  console.log(process.env.SCENARIO === "different core" ? "sha512-other" : process.env.CORE_INTEGRITY);
}
`,
            { mode: 0o755 },
          );
        const source = readFileSync(releaseScript, "utf8");
        const dispatch = source.indexOf('\ncase "$PHASE" in');
        expect(dispatch).toBeGreaterThan(0);
        const script = join(root, "resume.sh");
        writeFileSync(
          script,
          `${source.slice(0, dispatch)}
phase_verify_pack() { VERIFIED_CORE_TARBALL="$PWD/core.tgz"; }
phase_smoke() { echo smoke; }
phase_promote_latest() { echo promote; }
phase_publish_cli
`,
        );
        const result = spawnSync("bash", [script], {
          cwd: root,
          encoding: "utf8",
          env: {
            PATH: `${bin}:${process.env.PATH}`,
            HOME: root,
            CALL_LOG: log,
            CORE_INTEGRITY: integrity,
            SCENARIO: scenario,
          },
        });
        const publishes = readFileSync(log, "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as { name: string; args: string[] })
          .filter((call) => call.name === "pnpm");
        if (scenario === "matching core") {
          expect(result.status).toBe(0);
          expect(publishes.map((call) => call.args)).toEqual([
            ["publish", "--tag", "next", "--access", "public"],
          ]);
          expect(result.stdout).toContain("smoke\npromote");
        } else {
          expect(result.status).not.toBe(0);
          expect(publishes).toEqual([]);
          expect(result.stdout).not.toContain("smoke\npromote");
        }
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
});
