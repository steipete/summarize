import { isRecord } from "./parse-helpers.js";
import type {
  SpeakerAnchorConfig,
  SpeakerProfileConfig,
  SpeakerSourceConfig,
  SpeakersConfig,
} from "./types.js";

function parseOptionalString(raw: unknown, path: string, label: string): string | undefined {
  if (typeof raw === "undefined") return undefined;
  if (typeof raw !== "string" || !raw.trim()) {
    throw new Error(`Invalid config file ${path}: "${label}" must be a non-empty string.`);
  }
  return raw.trim();
}

function parseRequiredString(raw: unknown, path: string, label: string): string {
  const value = parseOptionalString(raw, path, label);
  if (!value) {
    throw new Error(`Invalid config file ${path}: "${label}" is required.`);
  }
  return value;
}

function parseOptionalBoolean(raw: unknown, path: string, label: string): boolean | undefined {
  if (typeof raw === "undefined") return undefined;
  if (typeof raw !== "boolean") {
    throw new Error(`Invalid config file ${path}: "${label}" must be a boolean.`);
  }
  return raw;
}

function parseOptionalConfidence(raw: unknown, path: string, label: string): number | undefined {
  if (typeof raw === "undefined") return undefined;
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0 || raw > 1) {
    throw new Error(`Invalid config file ${path}: "${label}" must be a number from 0 to 1.`);
  }
  return raw;
}

function parseKnownSpeakers(raw: unknown, path: string, label: string): string[] | undefined {
  if (typeof raw === "undefined") return undefined;
  if (!Array.isArray(raw)) {
    throw new Error(`Invalid config file ${path}: "${label}" must be an array of names.`);
  }
  const names: string[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    if (typeof entry !== "string" || !entry.trim()) {
      throw new Error(`Invalid config file ${path}: "${label}" must contain non-empty names.`);
    }
    const name = entry.trim();
    const key = name.toLocaleLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    names.push(name);
  }
  return names.length > 0 ? names : undefined;
}

function parseProfile(raw: unknown, path: string, label: string): SpeakerProfileConfig {
  if (!isRecord(raw)) {
    throw new Error(`Invalid config file ${path}: "${label}" must be an object.`);
  }
  const host = parseOptionalString(raw.host, path, `${label}.host`);
  const knownSpeakers = parseKnownSpeakers(raw.knownSpeakers, path, `${label}.knownSpeakers`);
  const context = parseOptionalString(raw.context, path, `${label}.context`);
  const model = parseOptionalString(raw.model, path, `${label}.model`);
  const minimumConfidence = parseOptionalConfidence(
    raw.minimumConfidence,
    path,
    `${label}.minimumConfidence`,
  );
  const autoIdentify = parseOptionalBoolean(raw.autoIdentify, path, `${label}.autoIdentify`);
  return {
    ...(host ? { host } : {}),
    ...(knownSpeakers ? { knownSpeakers } : {}),
    ...(context ? { context } : {}),
    ...(model ? { model } : {}),
    ...(typeof minimumConfidence === "number" ? { minimumConfidence } : {}),
    ...(typeof autoIdentify === "boolean" ? { autoIdentify } : {}),
  };
}

function parseAnchors(
  raw: unknown,
  path: string,
  label: string,
): SpeakerAnchorConfig[] | undefined {
  if (typeof raw === "undefined") return undefined;
  if (!Array.isArray(raw)) {
    throw new Error(`Invalid config file ${path}: "${label}" must be an array.`);
  }
  const anchors = raw.map((entry, index) => {
    const entryLabel = `${label}[${index}]`;
    if (!isRecord(entry)) {
      throw new Error(`Invalid config file ${path}: "${entryLabel}" must be an object.`);
    }
    return {
      at: parseRequiredString(entry.at, path, `${entryLabel}.at`),
      name: parseRequiredString(entry.name, path, `${entryLabel}.name`),
    };
  });
  return anchors.length > 0 ? anchors : undefined;
}

function parseMappings(
  raw: unknown,
  path: string,
  label: string,
): Record<string, string> | undefined {
  if (typeof raw === "undefined") return undefined;
  if (!isRecord(raw)) {
    throw new Error(`Invalid config file ${path}: "${label}" must be an object.`);
  }
  const mappings: Record<string, string> = {};
  for (const [speaker, rawName] of Object.entries(raw)) {
    if (!speaker.trim() || typeof rawName !== "string" || !rawName.trim()) {
      throw new Error(
        `Invalid config file ${path}: "${label}" must map non-empty labels to names.`,
      );
    }
    mappings[speaker.trim()] = rawName.trim();
  }
  return Object.keys(mappings).length > 0 ? mappings : undefined;
}

function parseSource(raw: unknown, path: string, label: string): SpeakerSourceConfig {
  if (!isRecord(raw)) {
    throw new Error(`Invalid config file ${path}: "${label}" must be an object.`);
  }
  const profile = parseOptionalString(raw.profile, path, `${label}.profile`);
  const anchors = parseAnchors(raw.anchors, path, `${label}.anchors`);
  const transcriptHash = parseOptionalString(raw.transcriptHash, path, `${label}.transcriptHash`);
  if (transcriptHash && !/^[a-f\d]{64}$/i.test(transcriptHash)) {
    throw new Error(
      `Invalid config file ${path}: "${label}.transcriptHash" must be a SHA-256 hash.`,
    );
  }
  const mappings = parseMappings(raw.mappings, path, `${label}.mappings`);
  if (Boolean(transcriptHash) !== Boolean(mappings)) {
    throw new Error(
      `Invalid config file ${path}: "${label}.transcriptHash" and "${label}.mappings" must be set together.`,
    );
  }
  return {
    ...(profile ? { profile } : {}),
    ...(anchors ? { anchors } : {}),
    ...(transcriptHash ? { transcriptHash: transcriptHash.toLowerCase() } : {}),
    ...(mappings ? { mappings } : {}),
  };
}

function parseRecord<T>(
  raw: unknown,
  path: string,
  label: string,
  parseValue: (value: unknown, path: string, label: string) => T,
): Record<string, T> | undefined {
  if (typeof raw === "undefined") return undefined;
  if (!isRecord(raw)) {
    throw new Error(`Invalid config file ${path}: "${label}" must be an object.`);
  }
  const result: Record<string, T> = {};
  for (const [rawKey, value] of Object.entries(raw)) {
    const key = rawKey.trim();
    if (!key) {
      throw new Error(`Invalid config file ${path}: "${label}" keys must not be empty.`);
    }
    result[key] = parseValue(value, path, `${label}.${key}`);
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

export function parseSpeakersConfig(
  root: Record<string, unknown>,
  path: string,
): SpeakersConfig | undefined {
  const raw = root.speakers;
  if (typeof raw === "undefined") return undefined;
  if (!isRecord(raw)) {
    throw new Error(`Invalid config file ${path}: "speakers" must be an object.`);
  }

  const defaultProfile = parseOptionalString(raw.defaultProfile, path, "speakers.defaultProfile");
  const autoIdentify = parseOptionalBoolean(raw.autoIdentify, path, "speakers.autoIdentify");
  const model = parseOptionalString(raw.model, path, "speakers.model");
  const minimumConfidence = parseOptionalConfidence(
    raw.minimumConfidence,
    path,
    "speakers.minimumConfidence",
  );
  const profiles = parseRecord(raw.profiles, path, "speakers.profiles", parseProfile);
  const sources = parseRecord(raw.sources, path, "speakers.sources", parseSource);

  if (defaultProfile && !profiles?.[defaultProfile]) {
    throw new Error(
      `Invalid config file ${path}: speakers.defaultProfile references unknown profile "${defaultProfile}".`,
    );
  }
  for (const [source, value] of Object.entries(sources ?? {})) {
    if (value.profile && !profiles?.[value.profile]) {
      throw new Error(
        `Invalid config file ${path}: speakers.sources.${source}.profile references unknown profile "${value.profile}".`,
      );
    }
  }

  return {
    ...(defaultProfile ? { defaultProfile } : {}),
    ...(typeof autoIdentify === "boolean" ? { autoIdentify } : {}),
    ...(model ? { model } : {}),
    ...(typeof minimumConfidence === "number" ? { minimumConfidence } : {}),
    ...(profiles ? { profiles } : {}),
    ...(sources ? { sources } : {}),
  };
}
