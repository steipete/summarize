import type { CliProvider } from "../config.js";

export const parseOptionalSetting = <T>(
  raw: unknown,
  parse: (value: string) => T,
  strict: boolean,
): T | null => {
  if (typeof raw !== "string") return null;
  try {
    return parse(raw);
  } catch (error) {
    if (strict) throw error;
    return null;
  }
};

export const parseOptionalBoolean = (
  raw: unknown,
  strict: boolean,
  label = "--timestamps",
): boolean | null => {
  if (typeof raw === "boolean") return raw;
  if (typeof raw !== "string") return null;
  const normalized = raw.trim().toLowerCase();
  if (!normalized) return null;
  if (normalized === "true" || normalized === "1" || normalized === "yes" || normalized === "on") {
    return true;
  }
  if (normalized === "false" || normalized === "0" || normalized === "no" || normalized === "off") {
    return false;
  }
  if (strict) {
    throw new Error(`Unsupported ${label}: ${raw}`);
  }
  return null;
};

export const parseCliProvider = (raw: string): CliProvider | null => {
  const normalized = raw.trim().toLowerCase();
  if (normalized === "claude") return "claude";
  if (normalized === "gemini") return "gemini";
  if (normalized === "codex") return "codex";
  if (normalized === "agent") return "agent";
  if (normalized === "openclaw") return "openclaw";
  if (normalized === "opencode") return "opencode";
  return null;
};

export const parseOptionalCliProviderOrder = (
  raw: unknown,
  strict: boolean,
): CliProvider[] | null => {
  if (typeof raw === "undefined" || raw === null) return null;
  const items: string[] = Array.isArray(raw)
    ? raw.filter((entry): entry is string => typeof entry === "string")
    : typeof raw === "string"
      ? raw
          .split(/[,\s]+/)
          .map((entry) => entry.trim())
          .filter(Boolean)
      : [];
  if (items.length === 0) {
    if (strict) throw new Error(`Unsupported --auto-cli-order: ${String(raw)}`);
    return null;
  }
  const out: CliProvider[] = [];
  for (const item of items) {
    const provider = parseCliProvider(item);
    if (!provider) {
      if (strict) throw new Error(`Unsupported --auto-cli-order provider: ${item}`);
      return null;
    }
    if (!out.includes(provider)) out.push(provider);
  }
  return out.length > 0 ? out : null;
};
