import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { formatTimestampMs } from "@steipete/summarize-core/content";
import { isRecord } from "../config/parse-helpers.js";
import { readParsedConfigFile } from "../config/read.js";
import type { SpeakerIdentificationSettings, SpeakerIdentityMapping } from "./types.js";

const CONFIG_LOCK_RETRY_MS = 50;
const CONFIG_LOCK_TIMEOUT_MS = 10_000;
const CONFIG_LOCK_STALE_MS = 5 * 60_000;

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function isNodeErrorWithCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

async function readLockInfo(lockPath: string) {
  return fs.lstat(lockPath).catch((error: unknown) => {
    if (isNodeErrorWithCode(error, "ENOENT")) return null;
    throw error;
  });
}

async function acquireConfigWriteLock(configPath: string): Promise<() => Promise<void>> {
  const lockPath = `${configPath}.lock`;
  const deadline = Date.now() + CONFIG_LOCK_TIMEOUT_MS;

  while (true) {
    try {
      const handle = await fs.open(lockPath, "wx", 0o600);
      const identity = await handle.stat();
      try {
        await handle.writeFile(`${process.pid}\n`, "utf8");
      } catch (error) {
        await handle.close().catch(() => {});
        await fs.unlink(lockPath).catch(() => {});
        throw error;
      }
      return async () => {
        await handle.close();
        const current = await readLockInfo(lockPath);
        if (current && current.dev === identity.dev && current.ino === identity.ino) {
          await fs.unlink(lockPath);
        }
      };
    } catch (error) {
      if (!isNodeErrorWithCode(error, "EEXIST")) throw error;
      const info = await readLockInfo(lockPath);
      if (info?.isFile() && Date.now() - info.mtimeMs > CONFIG_LOCK_STALE_MS) {
        await fs.unlink(lockPath).catch((unlinkError: unknown) => {
          if (!isNodeErrorWithCode(unlinkError, "ENOENT")) throw unlinkError;
        });
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for speaker config lock ${lockPath}.`);
      }
      await delay(CONFIG_LOCK_RETRY_MS);
    }
  }
}

function formatAnchorTimestampMs(value: number): string {
  const rounded = Math.max(0, Math.round(value));
  const wholeSeconds = formatTimestampMs(rounded);
  const milliseconds = rounded % 1_000;
  if (milliseconds === 0) return wholeSeconds;
  return `${wholeSeconds}.${milliseconds.toString().padStart(3, "0").replace(/0+$/, "")}`;
}

function mergeKnownSpeakers(existing: unknown, mappings: SpeakerIdentityMapping[]): string[] {
  const names = [
    ...(Array.isArray(existing)
      ? existing.filter((value): value is string => typeof value === "string")
      : []),
    ...mappings.map((mapping) => mapping.name),
  ];
  const result: string[] = [];
  const seen = new Set<string>();
  for (const raw of names) {
    const name = raw.trim();
    if (!name) continue;
    const key = name.toLocaleLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(name);
  }
  return result;
}

function mergeAnchors(existing: unknown, settings: SpeakerIdentificationSettings) {
  const values = [
    ...(Array.isArray(existing) ? existing.filter(isRecord) : []),
    ...settings.anchors.map((anchor) => ({
      at: formatAnchorTimestampMs(anchor.atMs),
      name: anchor.name,
    })),
  ];
  const result: Array<{ at: string; name: string }> = [];
  const seen = new Set<string>();
  for (const value of values) {
    const at = typeof value.at === "string" ? value.at.trim() : "";
    const name = typeof value.name === "string" ? value.name.trim() : "";
    if (!at || !name) continue;
    const key = `${at}\u0000${name.toLocaleLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ at, name });
  }
  return result;
}

export async function rememberSpeakerMappings({
  configPath,
  settings,
  mappings,
  transcriptHash,
}: {
  configPath: string;
  settings: SpeakerIdentificationSettings;
  mappings: SpeakerIdentityMapping[];
  transcriptHash: string;
}): Promise<void> {
  if (!settings.profileName) {
    throw new Error("Cannot remember speaker mappings without a speaker profile.");
  }
  if (mappings.length === 0) {
    throw new Error("No resolved speaker mappings are available to remember.");
  }

  const directory = dirname(configPath);
  await fs.mkdir(directory, { recursive: true });
  const releaseLock = await acquireConfigWriteLock(configPath);
  try {
    const existingInfo = await fs.lstat(configPath).catch((error: unknown) => {
      if (isNodeErrorWithCode(error, "ENOENT")) return null;
      throw new Error(
        `Unable to inspect existing config file ${configPath}: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    });
    if (existingInfo?.isSymbolicLink()) {
      throw new Error(`Refusing to replace symlinked config file ${configPath}.`);
    }
    const parsed = readParsedConfigFile(configPath);
    if (existingInfo && !parsed) {
      throw new Error(`Unable to read existing config file ${configPath}; refusing to replace it.`);
    }
    const root = parsed ?? {};
    const speakers = asRecord(root.speakers);
    const profiles = asRecord(speakers.profiles);
    const profile = asRecord(profiles[settings.profileName]);
    const sources = asRecord(speakers.sources);
    const source = asRecord(sources[settings.sourceKey]);
    const sourceProfile =
      typeof source.profile === "string" && source.profile.trim() ? source.profile.trim() : null;
    const sourceIdentityMatchesProfile = !sourceProfile || sourceProfile === settings.profileName;
    const sourceWithoutAnchors = { ...source };
    delete sourceWithoutAnchors.anchors;
    const anchors = mergeAnchors(
      sourceIdentityMatchesProfile ? source.anchors : undefined,
      settings,
    );

    profiles[settings.profileName] = {
      ...profile,
      knownSpeakers: mergeKnownSpeakers(profile.knownSpeakers, mappings),
    };
    sources[settings.sourceKey] = {
      ...sourceWithoutAnchors,
      profile: settings.profileName,
      ...(anchors.length > 0 ? { anchors } : {}),
      transcriptHash,
      mappings: Object.fromEntries(mappings.map((mapping) => [mapping.speaker, mapping.name])),
    };
    root.speakers = { ...speakers, profiles, sources };

    const tempPath = join(directory, `.config.json.${process.pid}.${randomUUID()}.tmp`);
    const mode = existingInfo ? existingInfo.mode & 0o777 : 0o600;
    try {
      await fs.writeFile(tempPath, `${JSON.stringify(root, null, 2)}\n`, {
        encoding: "utf8",
        mode,
        flag: "wx",
      });
      await fs.rename(tempPath, configPath);
    } finally {
      await fs.unlink(tempPath).catch(() => {});
    }
  } finally {
    await releaseLock();
  }
}
