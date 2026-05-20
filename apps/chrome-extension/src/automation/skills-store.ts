import defaultSkillsRaw from "./default-skills.json";

export type Skill = {
  name: string;
  domainPatterns: string[];
  shortDescription: string;
  description: string;
  createdAt: string;
  lastUpdated: string;
  examples: string;
  library: string;
};

const STORAGE_KEY = "automation.skills";
const SEEDED_KEY = "automation.skillsSeeded";
const FALLBACK_PREFIX = "summarize.";
const defaultSkills = defaultSkillsRaw as Skill[];

function getLocalStorageArea(): chrome.storage.StorageArea | null {
  return globalThis.chrome?.storage?.local ?? null;
}

function loadFallbackValue<T>(key: string, fallback: T): T {
  try {
    const raw = globalThis.localStorage?.getItem(`${FALLBACK_PREFIX}${key}`);
    if (!raw) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function saveFallbackValue(key: string, value: unknown): void {
  try {
    globalThis.localStorage?.setItem(`${FALLBACK_PREFIX}${key}`, JSON.stringify(value));
  } catch {
    // Best-effort fallback for non-extension previews.
  }
}

function normalizeName(value: string): string {
  return value.trim();
}

function nowIso(): string {
  return new Date().toISOString();
}

async function loadSkillsMap(): Promise<Record<string, Skill>> {
  const storage = getLocalStorageArea();
  const raw = storage
    ? (await storage.get(STORAGE_KEY))[STORAGE_KEY]
    : loadFallbackValue<Record<string, Skill>>(STORAGE_KEY, {});
  if (!raw || typeof raw !== "object") return {};
  return raw as Record<string, Skill>;
}

async function saveSkillsMap(map: Record<string, Skill>): Promise<void> {
  const storage = getLocalStorageArea();
  if (storage) {
    await storage.set({ [STORAGE_KEY]: map });
    return;
  }
  saveFallbackValue(STORAGE_KEY, map);
}

export async function ensureDefaultSkills(): Promise<void> {
  const storage = getLocalStorageArea();
  const seeded = storage
    ? (await storage.get(SEEDED_KEY))[SEEDED_KEY]
    : loadFallbackValue<boolean>(SEEDED_KEY, false);
  if (seeded) return;
  const map = await loadSkillsMap();
  let changed = false;
  for (const skill of defaultSkills) {
    const name = normalizeName(skill.name);
    if (!name || map[name]) continue;
    map[name] = skill;
    changed = true;
  }
  if (changed) await saveSkillsMap(map);
  if (storage) {
    await storage.set({ [SEEDED_KEY]: true });
  } else {
    saveFallbackValue(SEEDED_KEY, true);
  }
}

export async function listSkills(url?: string): Promise<Skill[]> {
  await ensureDefaultSkills();
  const map = await loadSkillsMap();
  const skills = Object.values(map);
  if (!url) return skills;
  return skills.filter((skill) => matchesAnyPattern(url, skill.domainPatterns));
}

export async function getSkill(name: string): Promise<Skill | null> {
  await ensureDefaultSkills();
  const map = await loadSkillsMap();
  return map[normalizeName(name)] ?? null;
}

export async function saveSkill(input: Skill): Promise<Skill> {
  await ensureDefaultSkills();
  const map = await loadSkillsMap();
  const name = normalizeName(input.name);
  const existing = map[name];
  const createdAt = existing?.createdAt ?? input.createdAt ?? nowIso();
  const lastUpdated = nowIso();
  const skill: Skill = { ...input, name, createdAt, lastUpdated };
  map[name] = skill;
  await saveSkillsMap(map);
  return skill;
}

export async function deleteSkill(name: string): Promise<boolean> {
  await ensureDefaultSkills();
  const map = await loadSkillsMap();
  const key = normalizeName(name);
  if (!map[key]) return false;
  delete map[key];
  await saveSkillsMap(map);
  return true;
}

function normalizeHost(value: string): string {
  return value.replace(/^www\./i, "").toLowerCase();
}

function wildcardToRegex(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, ".*")
    .replace(/\*/g, "[^/]*");
  return new RegExp(`^${escaped}$`, "i");
}

function matchesPattern(host: string, path: string, pattern: string): boolean {
  const parts = pattern.split("/").filter(Boolean);
  const domainPatternRaw = parts[0] ?? "";
  const pathPattern = parts.length > 1 ? `/${parts.slice(1).join("/")}` : "";
  if (!domainPatternRaw) return false;
  const domainPattern = normalizeHost(domainPatternRaw);
  const hostMatches = wildcardToRegex(domainPattern).test(normalizeHost(host));
  if (!hostMatches) return false;
  if (!pathPattern) return true;
  return wildcardToRegex(pathPattern).test(path);
}

export function matchesAnyPattern(url: string, patterns: string[]): boolean {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname;
    const path = parsed.pathname || "/";
    return patterns.some((pattern) => matchesPattern(host, path, pattern));
  } catch {
    return false;
  }
}
