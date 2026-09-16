import fs from "node:fs/promises";
import path from "node:path";
import { CliError } from "../locale.js";

function isWindowsShimPath(filePath: string): boolean {
  return /\.(cmd|bat|ps1)$/i.test(filePath);
}

export async function resolveCliEntrypointCandidatesFromWindowsShim(
  shimPath: string,
): Promise<string[]> {
  if (!isWindowsShimPath(shimPath)) return [];

  const shimDir = path.dirname(shimPath);
  const candidates = [
    path.resolve(shimDir, "node_modules", "@steipete", "summarize", "dist", "cli.cjs"),
    path.resolve(shimDir, "node_modules", "@steipete", "summarize", "dist", "cli.js"),
    path.resolve(shimDir, "..", "@steipete", "summarize", "dist", "cli.cjs"),
    path.resolve(shimDir, "..", "@steipete", "summarize", "dist", "cli.js"),
  ];

  try {
    const contents = await fs.readFile(shimPath, "utf8");
    const tokenMatch = contents.match(
      /(?:%~dp0|%dp0%|\$basedir)[^"'\\r\\n]*node_modules[\\/]+@steipete[\\/]+summarize[\\/]+dist[\\/]+cli\.(?:cjs|js)/i,
    );
    const matches = Array.from(
      contents.matchAll(
        /["']?([^"'\\r\\n]*node_modules[\\/]+@steipete[\\/]+summarize[\\/]+dist[\\/]+cli\.(?:cjs|js))["']?/gi,
      ),
    );
    const preferred =
      tokenMatch?.[0] ??
      matches.find((match) => /%~dp0|%dp0%|\$basedir/i.test(match[1] ?? ""))?.[1] ??
      matches[0]?.[1];
    if (preferred) {
      const hasBaseToken = /%~dp0|%dp0%|\$basedir/i.test(preferred);
      let resolved = preferred;
      resolved = resolved.replace(/%~dp0|%dp0%/gi, `${shimDir}${path.sep}`);
      resolved = resolved.replace(/\$basedir/gi, shimDir);
      if (!hasBaseToken && /^[\\/]+\\.\\.(?:[\\/]|$)/.test(resolved)) {
        resolved = resolved.replace(/^[\\/]+/, "");
        resolved = path.resolve(shimDir, resolved);
      }
      candidates.unshift(path.resolve(resolved));
    }
  } catch {
    // ignore shim parse failures; fall back to path heuristics
  }

  return Array.from(new Set(candidates));
}

export async function resolveCliEntrypointPathForService(): Promise<string> {
  const argv1 = process.argv[1];
  if (!argv1) throw new CliError("service.cliEntrypointMissing");

  // Resolve symlinks so that globally-installed bins (npm, bun, nvm, etc.)
  // point back to the real package directory instead of the symlink location.
  const resolvedArgv1 = path.resolve(argv1);
  const normalized = await fs.realpath(resolvedArgv1).catch(() => resolvedArgv1);
  const looksLikeDist = /[/\\]dist[/\\].+\.(cjs|js)$/.test(normalized);
  if (looksLikeDist) {
    await fs.access(normalized);
    return normalized;
  }

  const distCandidates = [
    path.resolve(path.dirname(normalized), "../dist/cli.cjs"),
    path.resolve(path.dirname(normalized), "../dist/cli.js"),
  ];

  if (process.platform === "win32") {
    const shimCandidates = await resolveCliEntrypointCandidatesFromWindowsShim(normalized);
    distCandidates.unshift(...shimCandidates);
  }

  for (const candidate of distCandidates) {
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      // keep going
    }
  }

  throw new CliError("service.cliBuildMissing", { paths: distCandidates.join(", ") });
}
