import type { AutoRule, AutoRuleKind, ModelConfig } from "./types.js";
import { isRecord } from "./parse-helpers.js";

function parseAutoRuleKind(value: unknown): AutoRuleKind | null {
  return value === "text" ||
    value === "website" ||
    value === "youtube" ||
    value === "image" ||
    value === "video" ||
    value === "file"
    ? (value as AutoRuleKind)
    : null;
}

function parseWhenKinds(raw: unknown, path: string): AutoRuleKind[] {
  if (!Array.isArray(raw)) {
    throw new Error(`Invalid config file ${path}: "model.rules[].when" must be an array of kinds.`);
  }

  if (raw.length === 0) {
    throw new Error(`Invalid config file ${path}: "model.rules[].when" must not be empty.`);
  }

  const kinds: AutoRuleKind[] = [];
  for (const entry of raw) {
    const kind = parseAutoRuleKind(entry);
    if (!kind) {
      throw new Error(`Invalid config file ${path}: unknown "when" kind "${String(entry)}".`);
    }
    if (!kinds.includes(kind)) kinds.push(kind);
  }

  return kinds;
}

function parseModelCandidates(raw: unknown, path: string): string[] {
  if (!Array.isArray(raw)) {
    throw new Error(
      `Invalid config file ${path}: "model.rules[].candidates" must be an array of strings.`,
    );
  }
  const candidates: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== "string") {
      throw new Error(
        `Invalid config file ${path}: "model.rules[].candidates" must be an array of strings.`,
      );
    }
    const trimmed = entry.trim();
    if (trimmed.length === 0) continue;
    candidates.push(trimmed);
  }
  if (candidates.length === 0) {
    throw new Error(`Invalid config file ${path}: "model.rules[].candidates" must not be empty.`);
  }
  return candidates;
}

function parseTokenBand(
  raw: unknown,
  path: string,
): { token?: { min?: number; max?: number }; candidates: string[] } {
  if (!isRecord(raw)) {
    throw new Error(`Invalid config file ${path}: "model.rules[].bands[]" must be an object.`);
  }

  const candidates = parseModelCandidates(raw.candidates, path);

  const token = (() => {
    if (typeof raw.token === "undefined") return undefined;
    if (!isRecord(raw.token)) {
      throw new Error(
        `Invalid config file ${path}: "model.rules[].bands[].token" must be an object.`,
      );
    }
    const min = typeof raw.token.min === "number" ? raw.token.min : undefined;
    const max = typeof raw.token.max === "number" ? raw.token.max : undefined;

    if (typeof min === "number" && (!Number.isFinite(min) || min < 0)) {
      throw new Error(
        `Invalid config file ${path}: "model.rules[].bands[].token.min" must be >= 0.`,
      );
    }
    if (typeof max === "number" && (!Number.isFinite(max) || max < 0)) {
      throw new Error(
        `Invalid config file ${path}: "model.rules[].bands[].token.max" must be >= 0.`,
      );
    }
    if (typeof min === "number" && typeof max === "number" && min > max) {
      throw new Error(
        `Invalid config file ${path}: "model.rules[].bands[].token.min" must be <= "token.max".`,
      );
    }

    return typeof min === "number" || typeof max === "number" ? { min, max } : undefined;
  })();

  return { ...(token ? { token } : {}), candidates };
}

export function parseModelConfig(
  raw: unknown,
  path: string,
  label: string,
): ModelConfig | undefined {
  if (typeof raw === "undefined") return undefined;

  if (typeof raw === "string") {
    const value = raw.trim();
    if (value.length === 0) {
      throw new Error(`Invalid config file ${path}: "${label}" must not be empty.`);
    }
    if (value.toLowerCase() === "auto") {
      return { mode: "auto" } satisfies ModelConfig;
    }
    if (value.includes("/")) {
      return { id: value } satisfies ModelConfig;
    }
    return { name: value } satisfies ModelConfig;
  }

  if (!isRecord(raw)) {
    throw new Error(`Invalid config file ${path}: "${label}" must be an object.`);
  }

  if (typeof raw.name === "string") {
    const name = raw.name.trim();
    if (name.length === 0) {
      throw new Error(`Invalid config file ${path}: "${label}.name" must not be empty.`);
    }
    if (name.toLowerCase() === "auto") {
      throw new Error(`Invalid config file ${path}: "${label}.name" must not be "auto".`);
    }
    return { name } satisfies ModelConfig;
  }

  if (typeof raw.id === "string") {
    const id = raw.id.trim();
    if (id.length === 0) {
      throw new Error(`Invalid config file ${path}: "${label}.id" must not be empty.`);
    }
    if (!id.includes("/")) {
      throw new Error(
        `Invalid config file ${path}: "${label}.id" must be provider-prefixed (e.g. "openai/gpt-5-mini").`,
      );
    }
    return { id } satisfies ModelConfig;
  }

  const hasRules = typeof raw.rules !== "undefined";
  if (raw.mode === "auto" || (!("mode" in raw) && hasRules)) {
    const rules = (() => {
      if (typeof raw.rules === "undefined") return undefined;
      if (!Array.isArray(raw.rules)) {
        throw new Error(`Invalid config file ${path}: "${label}.rules" must be an array.`);
      }
      const rulesParsed: AutoRule[] = [];
      for (const entry of raw.rules) {
        if (!isRecord(entry)) continue;
        const when =
          typeof entry.when === "undefined" ? undefined : parseWhenKinds(entry.when, path);

        const hasCandidates = typeof entry.candidates !== "undefined";
        const hasBands = typeof entry.bands !== "undefined";
        if (hasCandidates && hasBands) {
          throw new Error(
            `Invalid config file ${path}: "${label}.rules[]" must use either "candidates" or "bands" (not both).`,
          );
        }

        if (hasCandidates) {
          const candidates = parseModelCandidates(entry.candidates, path);
          rulesParsed.push({ ...(when ? { when } : {}), candidates });
          continue;
        }

        if (hasBands) {
          if (!Array.isArray(entry.bands) || entry.bands.length === 0) {
            throw new Error(
              `Invalid config file ${path}: "${label}.rules[].bands" must be a non-empty array.`,
            );
          }
          const bands = entry.bands.map((band) => parseTokenBand(band, path));
          rulesParsed.push({ ...(when ? { when } : {}), bands });
          continue;
        }

        throw new Error(
          `Invalid config file ${path}: "${label}.rules[]" must include "candidates" or "bands".`,
        );
      }
      return rulesParsed;
    })();
    return { mode: "auto", ...(rules ? { rules } : {}) } satisfies ModelConfig;
  }

  throw new Error(
    `Invalid config file ${path}: "${label}" must include either "id", "name", or { "mode": "auto" }.`,
  );
}

export function parseModelsConfig(
  root: Record<string, unknown>,
  path: string,
): Record<string, ModelConfig> | undefined {
  if (typeof root.bags !== "undefined") {
    throw new Error(
      `Invalid config file ${path}: legacy key "bags" is no longer supported. Use "models" instead.`,
    );
  }
  const raw = root.models;
  if (typeof raw === "undefined") return undefined;
  if (!isRecord(raw)) {
    throw new Error(`Invalid config file ${path}: "models" must be an object.`);
  }

  const out: Record<string, ModelConfig> = {};
  const seen = new Set<string>();
  for (const [keyRaw, value] of Object.entries(raw)) {
    const key = keyRaw.trim();
    if (!key) continue;
    const keyLower = key.toLowerCase();
    if (keyLower === "auto") {
      throw new Error(`Invalid config file ${path}: model name "auto" is reserved.`);
    }
    if (seen.has(keyLower)) {
      throw new Error(`Invalid config file ${path}: duplicate model name "${key}".`);
    }
    if (/\s/.test(key)) {
      throw new Error(`Invalid config file ${path}: model name "${key}" must not contain spaces.`);
    }
    if (key.includes("/")) {
      throw new Error(`Invalid config file ${path}: model name "${key}" must not include "/".`);
    }
    const parsedModel = parseModelConfig(value, path, `models.${key}`);
    if (!parsedModel) continue;
    if ("name" in parsedModel) {
      throw new Error(
        `Invalid config file ${path}: "models.${key}" must not reference another model.`,
      );
    }
    seen.add(keyLower);
    out[key] = parsedModel;
  }

  return Object.keys(out).length > 0 ? out : undefined;
}
