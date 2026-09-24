import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const releaseScript = fileURLToPath(new URL("../scripts/release.sh", import.meta.url));

describe.skipIf(process.platform === "win32")("release npm verification codes", () => {
  it.each([
    ["publish", "NPM_OTP"],
    ["publish", "NPM_CONFIG_OTP"],
    ["promote", "NPM_OTP"],
    ["deprecate", "NPM_OTP"],
    ["promote", "NPM_CONFIG_OTP"],
    ["deprecate", "NPM_CONFIG_OTP"],
  ])("passes %s credentials from %s without logging them", (phase, variable) => {
    const root = mkdtempSync(join(tmpdir(), "summarize-release-otp-"));
    const otp = "123456";
    try {
      const bin = join(root, "bin");
      const log = join(root, "npm.jsonl");
      mkdirSync(bin);
      writeFileSync(join(root, "package.json"), JSON.stringify({ version: "0.0.0" }));
      mkdirSync(join(root, "packages", "core"), { recursive: true });
      writeFileSync(
        join(root, "packages", "core", "package.json"),
        JSON.stringify({ version: "0.0.0" }),
      );
      writeFileSync(join(bin, "git"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
      for (const command of ["npm", "pnpm"])
        writeFileSync(
          join(bin, command),
          `#!${process.execPath}
require("node:fs").appendFileSync(process.env.MOCK_NPM_LOG, JSON.stringify({
  command: require("node:path").basename(process.argv[1]),
  args: process.argv.slice(2), otp: process.env.NPM_CONFIG_OTP
}) + "\\n");
if (process.argv[2] === "view" && process.argv[3]?.endsWith("@0.0.0")) process.exit(1);
process.stdout.write("fixture\\n");
`,
          { mode: 0o755 },
        );
      let script = releaseScript;
      if (phase === "publish") {
        script = join(root, "publish.sh");
        const source = readFileSync(releaseScript, "utf8");
        const dispatch = source.indexOf('\ncase "$PHASE" in');
        expect(dispatch).toBeGreaterThan(0);
        writeFileSync(
          script,
          `${source.slice(0, dispatch)}
phase_verify_pack() { :; }
phase_smoke() { :; }
phase_promote_latest() { :; }
phase_publish
`,
        );
      }
      const output = execFileSync("bash", [script, phase], {
        cwd: root,
        encoding: "utf8",
        env: {
          PATH: `${bin}:${process.env.PATH}`,
          HOME: root,
          MOCK_NPM_LOG: log,
          BAD_VERSION: "0.0.0",
          [variable]: otp,
        },
      });
      expect(output).not.toContain(otp);
      const calls = readFileSync(log, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { command: string; args: string[]; otp?: string });
      if (phase === "publish") {
        const publishes = calls.filter((call) => call.command === "pnpm");
        expect(publishes).toHaveLength(2);
        expect(publishes[0].args).toContain("packages/core");
        expect(publishes[1].args[0]).toBe("publish");
      } else
        expect(
          calls.some((call) => call.args[0] === (phase === "promote" ? "dist-tag" : "deprecate")),
        ).toBe(true);
      for (const call of calls) {
        expect(call.otp).toBe(otp);
        if (call.command === "pnpm") expect(call.args.slice(-2)).toEqual(["--otp", otp]);
        else {
          expect(call.args).not.toContain(otp);
          expect(call.args).not.toContain("--otp");
        }
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
