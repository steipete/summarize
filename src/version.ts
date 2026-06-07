import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

declare const __dirname: string | undefined;

export const FALLBACK_VERSION = "0.17.0";

export function resolvePackageVersion(importMetaUrl?: string): string {
  const injected =
    typeof process !== "undefined" && typeof process.env.SUMMARIZE_VERSION === "string"
      ? process.env.SUMMARIZE_VERSION.trim()
      : "";
  if (injected.length > 0) return injected;

  const startDir = (() => {
    if (typeof importMetaUrl === "string" && importMetaUrl.trim().length > 0) {
      try {
        return path.dirname(fileURLToPath(importMetaUrl));
      } catch {
        // ignore
      }
    }

    if (typeof __dirname === "string" && __dirname.length > 0) return __dirname;

    return process.cwd();
  })();
  let dir = startDir;

  for (let i = 0; i < 10; i += 1) {
    const candidate = path.join(dir, "package.json");
    try {
      const raw = fs.readFileSync(candidate, "utf8");
      const json = JSON.parse(raw) as { version?: unknown } | null;
      if (json && typeof json.version === "string" && json.version.trim().length > 0) {
        return json.version.trim();
      }
    } catch {
      // ignore
    }

    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  return FALLBACK_VERSION;
}

function truncateSha(sha: string, length = 8): string {
  const trimmed = sha.trim();
  if (!trimmed) return "";
  if (trimmed.length <= length) return trimmed;
  return trimmed.slice(0, length);
}

function readShortSha(filePath: string): string | null {
  try {
    const sha = truncateSha(fs.readFileSync(filePath, "utf8"));
    return sha.length > 0 ? sha : null;
  } catch {
    return null;
  }
}

function resolveGitCommonDir(gitDir: string): string {
  try {
    const raw = fs.readFileSync(path.join(gitDir, "commondir"), "utf8").trim();
    if (raw) return path.isAbsolute(raw) ? raw : path.resolve(gitDir, raw);
  } catch {
    // ignore
  }

  return gitDir;
}

function resolveGitRef(gitDir: string, ref: string): string | null {
  const directSha = readShortSha(path.join(gitDir, ref));
  if (directSha) return directSha;

  const commonDir = resolveGitCommonDir(gitDir);
  if (commonDir !== gitDir) {
    const commonSha = readShortSha(path.join(commonDir, ref));
    if (commonSha) return commonSha;
  }

  const packedRefsPaths =
    commonDir === gitDir
      ? [path.join(gitDir, "packed-refs")]
      : [path.join(gitDir, "packed-refs"), path.join(commonDir, "packed-refs")];
  for (const packedRefsPath of packedRefsPaths) {
    try {
      const packed = fs.readFileSync(packedRefsPath, "utf8");
      const lines = packed.split(/\r?\n/);
      for (const line of lines) {
        if (!line || line.startsWith("#") || line.startsWith("^")) continue;
        const [shaRaw, refName] = line.split(" ");
        if (refName?.trim() === ref) {
          const sha = truncateSha(shaRaw ?? "");
          if (sha.length > 0) return sha;
        }
      }
    } catch {
      // ignore
    }
  }

  return null;
}

function resolveGitShaFromGitDir(gitDir: string): string | null {
  const headPath = path.join(gitDir, "HEAD");
  let head = "";
  try {
    head = fs.readFileSync(headPath, "utf8").trim();
  } catch {
    return null;
  }

  if (!head) return null;
  if (!head.startsWith("ref:")) {
    const sha = truncateSha(head);
    return sha.length > 0 ? sha : null;
  }

  const ref = head.replace(/^ref:\s*/i, "").trim();
  if (!ref) return null;
  return resolveGitRef(gitDir, ref);
}

function findNearestPackageRoot(startDir: string): string | null {
  let dir = startDir;
  for (let i = 0; i < 10; i += 1) {
    try {
      if (fs.statSync(path.join(dir, "package.json")).isFile()) return dir;
    } catch {
      // ignore
    }

    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  return null;
}

export function resolveGitSha(importMetaUrl?: string): string | null {
  const injected =
    typeof process !== "undefined" && typeof process.env.SUMMARIZE_GIT_SHA === "string"
      ? process.env.SUMMARIZE_GIT_SHA.trim()
      : "";
  if (injected.length > 0) return truncateSha(injected);

  const startDir = (() => {
    if (typeof importMetaUrl === "string" && importMetaUrl.trim().length > 0) {
      try {
        return path.dirname(fileURLToPath(importMetaUrl));
      } catch {
        // ignore
      }
    }

    if (typeof __dirname === "string" && __dirname.length > 0) return __dirname;

    return process.cwd();
  })();

  const packageRoot = typeof importMetaUrl === "string" ? findNearestPackageRoot(startDir) : null;
  let dir = startDir;
  for (let i = 0; i < 10; i += 1) {
    const dotGit = path.join(dir, ".git");
    try {
      const stat = fs.statSync(dotGit);
      if (stat.isDirectory()) {
        const sha = resolveGitShaFromGitDir(dotGit);
        if (sha) return sha;
      } else if (stat.isFile()) {
        // Worktrees/submodules can have a file with: `gitdir: /path/to/actual/dir`
        const txt = fs.readFileSync(dotGit, "utf8");
        const match = txt.match(/gitdir:\s*(.+)\s*$/i);
        const gitDir = match?.[1]?.trim();
        if (gitDir) {
          const resolved = path.isAbsolute(gitDir) ? gitDir : path.resolve(dir, gitDir);
          const sha = resolveGitShaFromGitDir(resolved);
          if (sha) return sha;
        }
      }
    } catch {
      // ignore
    }

    const parent = path.dirname(dir);
    if (parent === dir) break;
    if (packageRoot && dir === packageRoot) break;
    dir = parent;
  }

  return null;
}

export function formatVersionLine(importMetaUrl?: string): string {
  const version = resolvePackageVersion(importMetaUrl);
  const sha = resolveGitSha(importMetaUrl);
  return sha ? `${version} (${sha})` : version;
}
