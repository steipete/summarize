import fs from "node:fs/promises";
import path from "node:path";

export async function resolveHomebrewServicePath(filePath: string): Promise<string> {
  // i18n-ignore: Homebrew filesystem layout, not interface text.
  const match = filePath.match(/^(.*)\/Cellar\/([^/]+)\/[^/]+\/(.+)$/);
  if (!match) return filePath;
  const [, prefix, formula, relativePath] = match;
  const optPath = path.join(prefix!, "opt", formula!, relativePath!);
  try {
    // Follow upgrades only when opt currently selects the exact installed keg.
    if ((await fs.realpath(optPath)) === (await fs.realpath(filePath))) return optPath;
  } catch {
    // A missing or unlinked opt path must not change the selected runtime.
  }
  return filePath;
}
