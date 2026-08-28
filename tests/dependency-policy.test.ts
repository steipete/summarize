import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

it("keeps Dependabot's npm cooldown aligned with pnpm's release age", () => {
  const workspace = readFileSync(new URL("../pnpm-workspace.yaml", import.meta.url), "utf8");
  const dependabot = readFileSync(new URL("../.github/dependabot.yml", import.meta.url), "utf8");
  const npmUpdate = dependabot
    .split(/(?=^  - package-ecosystem:)/m)
    .find((section) => section.startsWith('  - package-ecosystem: "npm"'));

  const releaseAgeMinutes = workspace.match(/^minimumReleaseAge: (\d+)$/m)?.[1];
  const cooldownDays = npmUpdate?.match(/^    cooldown:\n      default-days: (\d+)$/m)?.[1];

  expect(releaseAgeMinutes).toBeDefined();
  expect(cooldownDays).toBeDefined();
  expect(Number(cooldownDays) * 24 * 60).toBe(Number(releaseAgeMinutes));
});
