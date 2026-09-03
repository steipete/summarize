const TWITTER_HOSTS = new Set(["x.com", "twitter.com", "mobile.twitter.com"]);
const NITTER_HOSTS = [
  "nitter.net",
  "nitter.poast.org",
  "nitter.catsarch.com",
  "nitter.privacydev.net",
  "nitter.1d4.us",
];
const TWITTER_BLOCKED_TEXT_PATTERN =
  /something went wrong|try again|privacy related extensions|please disable them and try again|nitter\.net is offline|cease[- ]and[- ]desist|nitter development stopped/i;
const ANUBIS_TOKENS = ["anubis", "proof-of-work", "proof of work", "hashcash", "jshelter"];
const TWITTER_BROADCAST_PATH_PATTERN = /^\/i\/broadcasts\/[^/?#]+/i;

export function isTwitterStatusUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
    if (!TWITTER_HOSTS.has(host)) return false;
    return /\/status\/\d+/.test(parsed.pathname);
  } catch {
    return false;
  }
}

export function extractTweetId(url: string): string | null {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
    if (!TWITTER_HOSTS.has(host)) return null;
    const match = /\/status\/(\d+)/.exec(parsed.pathname);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

export function toTwitterSyndicationUrl(tweetId: string): string {
  return `https://cdn.syndication.twimg.com/tweet-result?id=${encodeURIComponent(tweetId)}&token=123`;
}

export function isTwitterBroadcastUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
    if (!TWITTER_HOSTS.has(host)) return false;
    return TWITTER_BROADCAST_PATH_PATTERN.test(parsed.pathname);
  } catch {
    return false;
  }
}

function rotateHosts<T>(values: T[], seed: number): T[] {
  if (values.length <= 1) return values.slice();
  const offset = Math.abs(seed) % values.length;
  return values.slice(offset).concat(values.slice(0, offset));
}

function hashSeed(input: string): number {
  let hash = 0;
  for (let i = 0; i < input.length; i += 1) {
    hash = (hash * 31 + input.charCodeAt(i)) | 0;
  }
  return hash;
}

export function toNitterUrls(url: string): string[] {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
    if (!TWITTER_HOSTS.has(host)) return [];
    const seed = hashSeed(`${parsed.pathname}${parsed.search}`);
    const rotated = rotateHosts(NITTER_HOSTS, seed);
    return rotated.map((nitterHost) => {
      const copy = new URL(parsed.toString());
      copy.hostname = nitterHost;
      copy.protocol = "https:";
      return copy.toString();
    });
  } catch {
    return [];
  }
}

export function isBlockedTwitterContent(content: string): boolean {
  if (!content) return false;
  return TWITTER_BLOCKED_TEXT_PATTERN.test(content);
}

export function isAnubisHtml(html: string): boolean {
  if (!html) return false;
  const lower = html.toLowerCase();
  if (!lower.includes("anubis")) return false;
  return ANUBIS_TOKENS.some((token) => lower.includes(token));
}
