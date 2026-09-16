import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export type BrowserName = "chrome" | "safari" | "firefox";

export type TwitterCookies = {
  cookiesFromBrowser: string | null;
  source: string | null;
};

export type CookieExtractionResult = {
  cookies: TwitterCookies;
  warnings: string[];
};

const DEFAULT_SOURCES: BrowserName[] = ["chrome", "safari", "firefox"];

// i18n-ignore: Literal environment-variable identifier for cookie selection.
const ENV_COOKIE_SOURCE_KEYS = ["TWITTER_COOKIE_SOURCE"] as const;
// i18n-ignore: Literal environment-variable identifier for browser profile selection.
const ENV_CHROME_PROFILE_KEYS = ["TWITTER_CHROME_PROFILE"] as const;
// i18n-ignore: Literal environment-variable identifier for browser profile selection.
const ENV_FIREFOX_PROFILE_KEYS = ["TWITTER_FIREFOX_PROFILE"] as const;

function normalizeValue(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function parseCookieSourceList(value: string, warnings: string[]): BrowserName[] | undefined {
  const tokens = value
    .split(/[,\s]+/)
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0);
  if (tokens.length === 0) return undefined;

  const result: BrowserName[] = [];
  for (const token of tokens) {
    if (token === "safari" || token === "chrome" || token === "firefox") {
      if (!result.includes(token)) result.push(token);
      continue;
    }
    warnings.push(`Unknown cookie source "${token}" in TWITTER_COOKIE_SOURCE`);
  }

  return result.length > 0 ? result : undefined;
}

function resolveEnvCookieSource(
  env: Record<string, string | undefined>,
  warnings: string[],
): BrowserName[] | undefined {
  for (const key of ENV_COOKIE_SOURCE_KEYS) {
    const value = normalizeValue(env[key]);
    if (value) return parseCookieSourceList(value, warnings);
  }
  return undefined;
}

function resolveEnvProfile(
  env: Record<string, string | undefined>,
  keys: readonly string[],
): string | undefined {
  for (const key of keys) {
    const value = normalizeValue(env[key]);
    if (value) return value;
  }
  return undefined;
}

function formatBrowserSourceLabel(browser: BrowserName, profile?: string): string {
  if (browser === "chrome") return profile ? `Chrome (${profile})` : "Chrome";
  if (browser === "firefox") return profile ? `Firefox (${profile})` : "Firefox";
  return "Safari";
}

function buildCookiesFromBrowserSpec(browser: BrowserName, profile?: string): string {
  if (browser === "safari" || !profile) return browser;
  return `${browser}:${profile}`;
}

function looksLikePath(value: string): boolean {
  return value.includes("/") || value.includes("\\");
}

function expandPath(value: string, homeDir: string): string {
  if (value.startsWith("~/")) return path.join(homeDir, value.slice(2));
  return path.isAbsolute(value) ? value : path.resolve(process.cwd(), value);
}

function safeStat(candidate: string): { isFile: () => boolean; isDirectory: () => boolean } | null {
  try {
    return statSync(candidate);
  } catch {
    return null;
  }
}

function resolveChromeCookiesDb(
  profile: string | undefined,
  platform: NodeJS.Platform,
  homeDir: string,
  env: Record<string, string | undefined>,
): string | null {
  const roots =
    platform === "darwin"
      ? [path.join(homeDir, "Library", "Application Support", "Google", "Chrome")]
      : platform === "linux"
        ? [path.join(homeDir, ".config", "google-chrome")]
        : platform === "win32"
          ? env.LOCALAPPDATA
            ? [path.join(env.LOCALAPPDATA, "Google", "Chrome", "User Data")]
            : []
          : [];

  const candidates: string[] = [];

  if (profile && looksLikePath(profile)) {
    const expanded = expandPath(profile, homeDir);
    const stat = safeStat(expanded);
    if (stat?.isFile()) return expanded;
    candidates.push(path.join(expanded, "Cookies"));
    candidates.push(path.join(expanded, "Network", "Cookies"));
  } else {
    const profileDir = profile && profile.trim().length > 0 ? profile.trim() : "Default";
    for (const root of roots) {
      candidates.push(path.join(root, profileDir, "Cookies"));
      candidates.push(path.join(root, profileDir, "Network", "Cookies"));
    }
  }

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }

  return null;
}

function resolveFirefoxCookiesDb(
  profile: string | undefined,
  platform: NodeJS.Platform,
  homeDir: string,
  env: Record<string, string | undefined>,
): string | null {
  const appData = env.APPDATA;
  const roots =
    platform === "darwin"
      ? [path.join(homeDir, "Library", "Application Support", "Firefox", "Profiles")]
      : platform === "linux"
        ? [path.join(homeDir, ".mozilla", "firefox")]
        : platform === "win32"
          ? appData
            ? [path.join(appData, "Mozilla", "Firefox", "Profiles")]
            : []
          : [];

  if (profile && looksLikePath(profile)) {
    const expanded = expandPath(profile, homeDir);
    const candidate = expanded.endsWith("cookies.sqlite")
      ? expanded
      : path.join(expanded, "cookies.sqlite");
    return existsSync(candidate) ? candidate : null;
  }

  for (const root of roots) {
    if (!root || !existsSync(root)) continue;
    if (profile) {
      const candidate = path.join(root, profile, "cookies.sqlite");
      if (existsSync(candidate)) return candidate;
      continue;
    }

    const entries = safeReaddir(root);
    const defaultRelease = entries.find((entry) => entry.includes("default-release"));
    const picked = defaultRelease ?? entries[0];
    if (!picked) continue;
    const candidate = path.join(root, picked, "cookies.sqlite");
    if (existsSync(candidate)) return candidate;
  }

  return null;
}

function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

function resolveSafariCookiesFile(platform: NodeJS.Platform, homeDir: string): string | null {
  if (platform !== "darwin") return null;
  const candidates = [
    path.join(homeDir, "Library", "Cookies", "Cookies.binarycookies"),
    path.join(
      homeDir,
      "Library",
      "Containers",
      "com.apple.Safari",
      "Data",
      "Library",
      "Cookies",
      "Cookies.binarycookies",
    ),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function hasCookiesStore(
  browser: BrowserName,
  profile: string | undefined,
  platform: NodeJS.Platform,
  homeDir: string,
  env: Record<string, string | undefined>,
): boolean {
  if (browser === "safari") {
    return Boolean(resolveSafariCookiesFile(platform, homeDir));
  }
  if (browser === "firefox") {
    return Boolean(resolveFirefoxCookiesDb(profile, platform, homeDir, env));
  }
  return Boolean(resolveChromeCookiesDb(profile, platform, homeDir, env));
}

export async function resolveTwitterCookies({
  env,
  cookieSource,
  chromeProfile,
  firefoxProfile,
  platform,
  homeDir,
}: {
  env: Record<string, string | undefined>;
  cookieSource?: BrowserName | BrowserName[];
  chromeProfile?: string;
  firefoxProfile?: string;
  platform?: NodeJS.Platform;
  homeDir?: string;
}): Promise<CookieExtractionResult> {
  const warnings: string[] = [];
  const cookies: TwitterCookies = {
    cookiesFromBrowser: null,
    source: null,
  };

  const envCookieSource = resolveEnvCookieSource(env, warnings);
  const envChromeProfile = resolveEnvProfile(env, ENV_CHROME_PROFILE_KEYS);
  const envFirefoxProfile = resolveEnvProfile(env, ENV_FIREFOX_PROFILE_KEYS);

  const effectiveCookieSource = cookieSource ?? envCookieSource;
  const effectiveChromeProfile = chromeProfile ?? envChromeProfile;
  const effectiveFirefoxProfile = firefoxProfile ?? envFirefoxProfile;

  const sourcesToTry: BrowserName[] = Array.isArray(effectiveCookieSource)
    ? effectiveCookieSource
    : effectiveCookieSource
      ? [effectiveCookieSource]
      : DEFAULT_SOURCES;

  const runtimePlatform = platform ?? process.platform;
  const runtimeHome = homeDir ?? homedir();

  let firstCandidate: { spec: string; label: string } | null = null;

  for (const source of sourcesToTry) {
    const profile =
      source === "chrome"
        ? effectiveChromeProfile
        : source === "firefox"
          ? effectiveFirefoxProfile
          : undefined;
    const spec = buildCookiesFromBrowserSpec(source, profile);
    const label = formatBrowserSourceLabel(source, profile);
    if (!firstCandidate) firstCandidate = { spec, label };

    if (hasCookiesStore(source, profile, runtimePlatform, runtimeHome, env)) {
      cookies.cookiesFromBrowser = spec;
      cookies.source = label;
      return { cookies, warnings };
    }
  }

  const hasExplicitSources = Boolean(effectiveCookieSource);

  if (hasExplicitSources && firstCandidate) {
    warnings.push(
      `No cookie store found for ${firstCandidate.label}. yt-dlp will still attempt it.`,
    );
    cookies.cookiesFromBrowser = firstCandidate.spec;
    cookies.source = firstCandidate.label;
    return { cookies, warnings };
  }

  warnings.push(
    "No browser cookies found for X/Twitter. Log into x.com in Chrome, Safari, or Firefox.",
  );
  return { cookies, warnings };
}
