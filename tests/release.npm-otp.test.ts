import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const releaseScript = fileURLToPath(new URL("../scripts/release.sh", import.meta.url));

describe.skipIf(process.platform === "win32")("release npm verification codes", () => {
  it.each([
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
      writeFileSync(
        join(bin, "npm"),
        `#!${process.execPath}
require("node:fs").appendFileSync(process.env.MOCK_NPM_LOG, JSON.stringify({
  args: process.argv.slice(2), otp: process.env.NPM_CONFIG_OTP
}) + "\\n");
process.stdout.write("fixture\\n");
`,
        { mode: 0o755 },
      );
      const output = execFileSync("bash", [releaseScript, phase], {
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
        .map((line) => JSON.parse(line) as { args: string[]; otp?: string });
      expect(
        calls.some((call) => call.args[0] === (phase === "promote" ? "dist-tag" : "deprecate")),
      ).toBe(true);
      for (const call of calls) {
        expect(call.otp).toBe(otp);
        expect(call.args).not.toContain(otp);
        expect(call.args).not.toContain("--otp");
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
