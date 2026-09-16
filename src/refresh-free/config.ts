import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import JSON5 from "json5";
import { CliError } from "../locale.js";

export function resolveRefreshFreeConfigPath(env: Record<string, string | undefined>): string {
  const home = env.HOME?.trim() || homedir();
  if (!home) throw new CliError("error.missingHome");
  return join(home, ".summarize", "config.json");
}

function assertNoComments(raw: string, path: string): void {
  let inString: '"' | "'" | null = null;
  let escaped = false;
  let line = 1;
  let col = 1;

  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i] ?? "";
    const next = raw[i + 1] ?? "";

    if (inString) {
      if (escaped) {
        escaped = false;
        col += 1;
        continue;
      }
      if (ch === "\\") {
        escaped = true;
        col += 1;
        continue;
      }
      if (ch === inString) inString = null;
      if (ch === "\n") {
        line += 1;
        col = 1;
      } else {
        col += 1;
      }
      continue;
    }

    if (ch === '"' || ch === "'") {
      inString = ch as '"' | "'";
      escaped = false;
      col += 1;
      continue;
    }
    if (ch === "/" && next === "/") {
      throw new CliError("error.configLineComment", {
        path: String(path),
        line: String(line),
        col: String(col),
      });
    }
    if (ch === "/" && next === "*") {
      throw new CliError("error.configBlockComment", {
        path: String(path),
        line: String(line),
        col: String(col),
      });
    }
    if (ch === "\n") {
      line += 1;
      col = 1;
    } else {
      col += 1;
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readConfigRoot(configPath: string): Promise<Record<string, unknown>> {
  try {
    const raw = await readFile(configPath, "utf8");
    assertNoComments(raw, configPath);
    const parsed = JSON5.parse(raw) as unknown;
    if (!isRecord(parsed)) {
      throw new CliError("error.configObject", { configPath: String(configPath) });
    }
    return parsed;
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code;
    if (code === "ENOENT") return {};
    throw error;
  }
}

export async function writeFreeModelConfig({
  env,
  candidates,
  setDefault,
}: {
  env: Record<string, string | undefined>;
  candidates: string[];
  setDefault: boolean;
}): Promise<string> {
  const configPath = resolveRefreshFreeConfigPath(env);
  const root = await readConfigRoot(configPath);
  const configModelsRaw = root.models;
  const configModels = (() => {
    if (typeof configModelsRaw === "undefined") return {};
    if (!isRecord(configModelsRaw)) {
      throw new CliError("error.configModelsObject", { configPath: String(configPath) });
    }
    return { ...configModelsRaw };
  })();

  configModels.free = { rules: [{ candidates }] };
  root.models = configModels;
  if (setDefault) root.model = "free";

  const configDir = dirname(configPath);
  await mkdir(configDir, { recursive: true, mode: 0o700 });
  await chmod(configDir, 0o700).catch(() => {});
  const tmp = `${configPath}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmp, `${JSON.stringify(root, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(tmp, configPath);
  await chmod(configPath, 0o600).catch(() => {});
  return configPath;
}
