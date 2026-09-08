export function looksLikeRssOrAtomFeed(xml: string): boolean {
  const head = xml.slice(0, 4096).trimStart().toLowerCase();
  if (head.startsWith("<rss") || head.includes("<rss")) return true;
  if (head.startsWith("<?xml") && (head.includes("<rss") || head.includes("<feed"))) return true;
  if (head.startsWith("<feed") || head.includes("<feed")) return true;
  return false;
}

export function extractEnclosureFromFeed(
  xml: string,
): { enclosureUrl: string; durationSeconds: number | null } | null {
  const items = extractFeedItems(xml);
  for (const item of items) {
    const enclosureUrl = extractEnclosureUrlFromItem(item);
    if (!enclosureUrl) continue;
    return { enclosureUrl, durationSeconds: extractItemDurationSeconds(item) };
  }

  const enclosureMatch = xml.match(/<enclosure\b[^>]*\burl\s*=\s*(['"])([^'"]+)\1/i);
  if (enclosureMatch?.[2]) {
    return { enclosureUrl: enclosureMatch[2], durationSeconds: extractItemDurationSeconds(xml) };
  }

  const atomMatch = xml.match(
    /<link\b[^>]*\brel\s*=\s*(['"])enclosure\1[^>]*\bhref\s*=\s*(['"])([^'"]+)\2/i,
  );
  if (atomMatch?.[3]) {
    return { enclosureUrl: atomMatch[3], durationSeconds: extractItemDurationSeconds(xml) };
  }

  return null;
}

export function extractEnclosureForEpisode(
  feedXml: string,
  episodeTitle: string,
): { enclosureUrl: string; durationSeconds: number | null } | null {
  const normalizedTarget = normalizeLooseTitle(episodeTitle);
  if (!normalizedTarget) return null;
  const items = extractFeedItems(feedXml);
  for (const item of items) {
    const title = extractItemTitle(item);
    if (!title) continue;
    if (normalizeLooseTitle(title) !== normalizedTarget) continue;
    const enclosureUrl = extractEnclosureUrlFromItem(item);
    if (!enclosureUrl) continue;
    return { enclosureUrl, durationSeconds: extractItemDurationSeconds(item) };
  }
  return null;
}

export function extractItemDurationSeconds(itemXml: string): number | null {
  const match = itemXml.match(/<itunes:duration>([\s\S]*?)<\/itunes:duration>/i);
  if (!match?.[1]) return null;
  const raw = match[1]
    .replaceAll(/<!\[CDATA\[/gi, "")
    .replaceAll(/\]\]>/g, "")
    .trim();
  if (!raw) return null;

  if (/^\d+$/.test(raw)) {
    const seconds = Number(raw);
    return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
  }

  const parts = raw.split(":").map((value) => value.trim());
  if (parts.length < 2 || parts.length > 3) return null;
  if (parts.some((value) => !/^\d+$/.test(value))) return null;
  const nums = parts.map((value) => Number(value));
  if (nums.some((n) => !Number.isFinite(n) || n < 0)) return null;
  const seconds = (() => {
    if (nums.length === 3) {
      const [hours, minutes, secondsRaw] = nums;
      if (hours === undefined || minutes === undefined || secondsRaw === undefined) return null;
      if (minutes >= 60 || secondsRaw >= 60) return null;
      return Math.round(hours * 3600 + minutes * 60 + secondsRaw);
    }
    const [minutes, secondsRaw] = nums;
    if (minutes === undefined || secondsRaw === undefined) return null;
    if (secondsRaw >= 60) return null;
    return Math.round(minutes * 60 + secondsRaw);
  })();
  if (seconds === null) return null;
  return seconds > 0 ? seconds : null;
}

export function decodeXmlEntities(value: string): string {
  return value
    .replaceAll(/&amp;/gi, "&")
    .replaceAll(/&#38;/g, "&")
    .replaceAll(/&lt;/gi, "<")
    .replaceAll(/&gt;/gi, ">")
    .replaceAll(/&quot;/gi, '"')
    .replaceAll(/&apos;/gi, "'");
}

export function normalizeLooseTitle(value: string): string {
  const normalized = value
    .toLowerCase()
    .normalize("NFKD")
    // Keep Latin accent folding, but preserve meaningful marks in other scripts.
    .replaceAll(/(\p{Script=Latin})\p{M}+/gu, "$1")
    .replaceAll(/[^\p{L}\p{M}\p{N}]+/gu, " ")
    .trim();
  return /[\p{L}\p{N}]/u.test(normalized) ? normalized : "";
}

export function extractFeedItems(xml: string): string[] {
  return xml.match(/<item\b[\s\S]*?<\/item>/gi) ?? [];
}

export function extractItemTitle(itemXml: string): string | null {
  const match = itemXml.match(/<title>([\s\S]*?)<\/title>/i);
  if (!match?.[1]) return null;
  const raw = match[1]
    .replaceAll(/<!\[CDATA\[/gi, "")
    .replaceAll(/\]\]>/g, "")
    .trim();
  return raw.length > 0 ? raw : null;
}

export function extractEnclosureUrlFromItem(xml: string): string | null {
  const enclosureMatch = xml.match(/<enclosure\b[^>]*\burl\s*=\s*(['"])([^'"]+)\1/i);
  if (enclosureMatch?.[2]) return enclosureMatch[2];

  const atomMatch = xml.match(
    /<link\b[^>]*\brel\s*=\s*(['"])enclosure\1[^>]*\bhref\s*=\s*(['"])([^'"]+)\2/i,
  );
  if (atomMatch?.[3]) return atomMatch[3];

  return null;
}
