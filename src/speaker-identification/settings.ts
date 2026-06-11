import { extractYouTubeVideoId, parseTimestampStringToMs } from "@steipete/summarize-core/content";
import type { SpeakerAnchorConfig, SpeakerProfileConfig } from "../config.js";
import type {
  ResolveSpeakerIdentificationInput,
  SpeakerAnchor,
  SpeakerIdentificationSettings,
} from "./types.js";

export const DEFAULT_SPEAKER_IDENTIFICATION_MODEL = "openai/gpt-5.5";
export const DEFAULT_SPEAKER_IDENTIFICATION_CONFIDENCE = 0.85;

export function buildSpeakerSourceKey(sourceUrl: string): string {
  const videoId = extractYouTubeVideoId(sourceUrl);
  return videoId ? `youtube:${videoId}` : sourceUrl.trim();
}

export function parseSpeakerAnchor(raw: string, flag = "--speaker-at"): SpeakerAnchor {
  const separator = raw.indexOf("=");
  if (separator <= 0 || separator === raw.length - 1) {
    throw new Error(`${flag} must use <timestamp=name>, for example 01:23=Chris Williamson.`);
  }
  const rawTimestamp = raw.slice(0, separator).trim();
  const name = raw.slice(separator + 1).trim();
  const atMs = parseTimestampStringToMs(rawTimestamp);
  if (atMs == null || !name) {
    throw new Error(`${flag} must use a valid <timestamp=name> value; received "${raw}".`);
  }
  return { atMs, name };
}

function parseConfigAnchor(anchor: SpeakerAnchorConfig): SpeakerAnchor {
  return parseSpeakerAnchor(`${anchor.at}=${anchor.name}`, "speakers.sources[].anchors[]");
}

function normalizeProfileName(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function normalizeModel(value: string | null | undefined): string {
  const trimmed = value?.trim() || DEFAULT_SPEAKER_IDENTIFICATION_MODEL;
  const canonical = trimmed.includes("/") ? trimmed : `openai/${trimmed}`;
  if (!canonical.toLowerCase().startsWith("openai/")) {
    throw new Error(`Speaker identification model must be an OpenAI model; received "${trimmed}".`);
  }
  return canonical;
}

function collectKnownSpeakers(profile: SpeakerProfileConfig | null): string[] {
  const names = [profile?.host, ...(profile?.knownSpeakers ?? [])].filter(
    (value): value is string => Boolean(value?.trim()),
  );
  const result: string[] = [];
  const seen = new Set<string>();
  for (const raw of names) {
    const name = raw.trim();
    const key = name.toLocaleLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(name);
  }
  return result;
}

function mergeAnchors(...groups: SpeakerAnchor[][]): SpeakerAnchor[] {
  const byTimestamp = new Map<number, SpeakerAnchor>();
  for (const anchor of groups.flat()) {
    const existing = byTimestamp.get(anchor.atMs);
    if (existing && existing.name.toLocaleLowerCase() !== anchor.name.toLocaleLowerCase()) {
      throw new Error(
        `Conflicting speaker anchors at ${anchor.atMs}ms: "${existing.name}" and "${anchor.name}".`,
      );
    }
    byTimestamp.set(anchor.atMs, anchor);
  }
  return [...byTimestamp.values()].sort((a, b) => a.atMs - b.atMs);
}

export function resolveSpeakerIdentificationSettings({
  config,
  sourceUrl,
  diarization,
  profileArg,
  anchorArgs,
  identifyOverride,
  remember,
}: ResolveSpeakerIdentificationInput): SpeakerIdentificationSettings | null {
  const sourceKey = buildSpeakerSourceKey(sourceUrl);
  const source = config?.sources?.[sourceKey] ?? null;
  const explicitProfile = normalizeProfileName(profileArg);
  const sourceProfile = normalizeProfileName(source?.profile);
  const profileName =
    explicitProfile ?? sourceProfile ?? normalizeProfileName(config?.defaultProfile);
  const profile = profileName ? (config?.profiles?.[profileName] ?? null) : null;
  const cliAnchors = anchorArgs.map((anchor) => parseSpeakerAnchor(anchor));
  const sourceIdentityMatchesProfile = !sourceProfile || sourceProfile === profileName;
  const sourceAnchors = sourceIdentityMatchesProfile
    ? (source?.anchors ?? []).map(parseConfigAnchor)
    : [];
  const explicit =
    identifyOverride !== null || Boolean(explicitProfile) || cliAnchors.length > 0 || remember;

  if (identifyOverride === false && (explicitProfile || cliAnchors.length > 0 || remember)) {
    throw new Error(
      "--no-identify-speakers cannot be combined with --speaker-profile, --speaker-at, or --remember-speakers.",
    );
  }
  if (explicit && identifyOverride !== false && !diarization) {
    throw new Error("Speaker identification requires --diarize.");
  }
  if (!diarization || identifyOverride === false) return null;
  if (profileName && !profile && !remember) {
    throw new Error(`Unknown speaker profile "${profileName}" in ~/.summarize/config.json.`);
  }
  if (remember && !profileName) {
    throw new Error("--remember-speakers requires --speaker-profile or speakers.defaultProfile.");
  }

  const autoIdentify = profile?.autoIdentify ?? config?.autoIdentify ?? false;
  const hasStoredIdentity =
    sourceIdentityMatchesProfile && (sourceAnchors.length > 0 || Boolean(source?.mappings));
  if (!explicit && !autoIdentify && !hasStoredIdentity) return null;

  return {
    sourceKey,
    profileName,
    host: profile?.host?.trim() || null,
    knownSpeakers: collectKnownSpeakers(profile),
    context: profile?.context?.trim() || null,
    model: normalizeModel(profile?.model ?? config?.model),
    minimumConfidence:
      profile?.minimumConfidence ??
      config?.minimumConfidence ??
      DEFAULT_SPEAKER_IDENTIFICATION_CONFIDENCE,
    anchors: mergeAnchors(sourceAnchors, cliAnchors),
    remembered:
      sourceIdentityMatchesProfile && source?.transcriptHash && source.mappings
        ? { transcriptHash: source.transcriptHash, mappings: source.mappings }
        : null,
    remember,
    explicit,
  };
}
