import { execFileTracked } from "../processes.js";
import { BIRD_TIP, TWITTER_HOSTS } from "./constants.js";
import { hasBirdCli, hasXurlCli } from "./env.js";

export type TweetCliClient = "xurl" | "bird";

type BirdTweetPayload = {
  id?: string;
  text: string;
  author?: { username?: string; name?: string };
  createdAt?: string;
  media?: BirdTweetMedia | null;
  client?: TweetCliClient;
};

type BirdTweetMedia = {
  kind: "video" | "audio";
  urls: string[];
  preferredUrl: string | null;
  source: "extended_entities" | "card" | "entities" | "xurl";
};

const URL_PREFIX_PATTERN = /^https?:\/\//i;

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" ? (value as Record<string, unknown>) : null;

const asArray = (value: unknown): unknown[] | null => (Array.isArray(value) ? value : null);

const asString = (value: unknown): string | null => (typeof value === "string" ? value : null);

const asNumber = (value: unknown): number | null => (typeof value === "number" ? value : null);

const isLikelyVideoUrl = (url: string): boolean =>
  url.includes("video.twimg.com") || url.includes("/i/broadcasts/") || url.endsWith(".m3u8");

const addUrl = (set: Set<string>, value: string | null) => {
  if (!value) return;
  if (!URL_PREFIX_PATTERN.test(value)) return;
  set.add(value);
};

const stripAnsi = (value: string): string => value.replace(/\u001b\[[0-9;]*m/g, "");

function parseTweetId(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (/^\d+$/.test(trimmed)) return trimmed;
  try {
    const parsed = new URL(trimmed);
    const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
    if (!TWITTER_HOSTS.has(host)) return null;
    const match = parsed.pathname.match(/\/status\/(\d+)/);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

function extractMediaFromBirdRaw(raw: unknown): BirdTweetMedia | null {
  const root = asRecord(raw);
  if (!root) return null;

  const legacy = asRecord(root.legacy);
  const extended = asRecord(legacy?.extended_entities);
  const mediaEntries = asArray(extended?.media);
  if (mediaEntries && mediaEntries.length > 0) {
    const urls = new Set<string>();
    let preferredUrl: string | null = null;
    let preferredBitrate = -1;
    let kind: BirdTweetMedia["kind"] = "video";

    for (const entry of mediaEntries) {
      const media = asRecord(entry);
      const mediaType = asString(media?.type);
      if (mediaType === "audio") {
        kind = "audio";
      }
      if (mediaType !== "video" && mediaType !== "animated_gif" && mediaType !== "audio") {
        continue;
      }
      const videoInfo = asRecord(media?.video_info);
      const variants = asArray(videoInfo?.variants);
      if (!variants) continue;
      for (const variant of variants) {
        const variantRecord = asRecord(variant);
        const url = asString(variantRecord?.url);
        if (!url) continue;
        addUrl(urls, url);
        const contentType = asString(variantRecord?.content_type) ?? "";
        const bitrate = asNumber(variantRecord?.bitrate) ?? -1;
        if (contentType.includes("video/mp4") && bitrate >= preferredBitrate) {
          preferredBitrate = bitrate;
          preferredUrl = url;
        } else if (!preferredUrl) {
          preferredUrl = url;
        }
      }
    }

    if (urls.size > 0) {
      return {
        kind,
        urls: Array.from(urls),
        preferredUrl,
        source: "extended_entities",
      };
    }
  }

  const card = asRecord(root.card);
  const cardLegacy = asRecord(card?.legacy);
  const bindings = asArray(cardLegacy?.binding_values);
  if (bindings) {
    const urls = new Set<string>();
    for (const binding of bindings) {
      const record = asRecord(binding);
      const key = asString(record?.key);
      if (key !== "broadcast_url") continue;
      const value = asRecord(record?.value);
      const url = asString(value?.string_value);
      addUrl(urls, url);
    }
    if (urls.size > 0) {
      const preferredUrl = urls.values().next().value ?? null;
      return {
        kind: "video",
        urls: Array.from(urls),
        preferredUrl,
        source: "card",
      };
    }
  }

  const entities = asRecord(legacy?.entities);
  const entityUrls = asArray(entities?.urls);
  if (entityUrls) {
    const urls = new Set<string>();
    for (const entity of entityUrls) {
      const record = asRecord(entity);
      const expanded = asString(record?.expanded_url);
      if (!expanded || !isLikelyVideoUrl(expanded)) continue;
      addUrl(urls, expanded);
    }
    if (urls.size > 0) {
      const preferredUrl = urls.values().next().value ?? null;
      return {
        kind: "video",
        urls: Array.from(urls),
        preferredUrl,
        source: "entities",
      };
    }
  }

  return null;
}

function extractMediaFromXurlRaw(raw: unknown): BirdTweetMedia | null {
  const root = asRecord(raw);
  if (!root) return null;

  const data = asRecord(root.data);
  const includes = asRecord(root.includes);
  const attachments = asRecord(data?.attachments);
  const mediaKeys = new Set(
    (asArray(attachments?.media_keys) ?? [])
      .map((value) => asString(value))
      .filter((value): value is string => Boolean(value)),
  );
  const mediaEntries = asArray(includes?.media) ?? [];
  if (mediaEntries.length === 0) return null;

  const urls = new Set<string>();
  let preferredUrl: string | null = null;
  let preferredBitrate = -1;
  let kind: BirdTweetMedia["kind"] = "video";

  for (const entry of mediaEntries) {
    const media = asRecord(entry);
    const mediaKey = asString(media?.media_key);
    if (mediaKeys.size > 0 && mediaKey && !mediaKeys.has(mediaKey)) continue;

    const mediaType = asString(media?.type);
    if (mediaType !== "video" && mediaType !== "animated_gif" && mediaType !== "audio") continue;
    if (mediaType === "audio") kind = "audio";

    for (const variant of asArray(media?.variants) ?? []) {
      const record = asRecord(variant);
      const url = asString(record?.url);
      if (!url) continue;
      addUrl(urls, url);
      const contentType = asString(record?.content_type) ?? "";
      const bitrate = asNumber(record?.bit_rate) ?? -1;
      if (contentType.includes("video/mp4") && bitrate >= preferredBitrate) {
        preferredBitrate = bitrate;
        preferredUrl = url;
      } else if (!preferredUrl) {
        preferredUrl = url;
      }
    }

    const directUrl = asString(media?.url);
    if (directUrl) {
      addUrl(urls, directUrl);
      if (!preferredUrl) preferredUrl = directUrl;
    }
  }

  if (urls.size === 0) return null;
  return {
    kind,
    urls: Array.from(urls),
    preferredUrl,
    source: "xurl",
  };
}

function isTwitterStatusUrl(raw: string): boolean {
  try {
    const parsed = new URL(raw);
    const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
    if (!TWITTER_HOSTS.has(host)) return false;
    return /\/status\/\d+/.test(parsed.pathname);
  } catch {
    return false;
  }
}

function buildXurlTweetEndpoint(tweetId: string): string {
  const params = new URLSearchParams({
    expansions: "author_id,attachments.media_keys",
    "tweet.fields": "created_at,attachments,entities,note_tweet,article",
    "user.fields": "username,name",
    "media.fields": "type,url,preview_image_url,variants",
  });
  return `/2/tweets/${tweetId}?${params.toString()}`;
}

function resolveXurlArticleText(article: Record<string, unknown> | null): string | null {
  if (!article) return null;

  const title = asString(article.title)?.trim() ?? "";
  const body =
    asString(article.text)?.trim() ??
    asString(article.body)?.trim() ??
    asString(article.preview_text)?.trim() ??
    asString(article.excerpt)?.trim() ??
    "";

  if (title && body && !body.includes(title)) {
    return `${title}\n\n${body}`;
  }
  if (body) return body;
  if (title) return title;

  const articleResults = asRecord(article.article_results);
  const articleResult = asRecord(articleResults?.result);
  if (!articleResult) return null;
  return resolveXurlArticleText(articleResult);
}

function resolveXurlTweetText(data: Record<string, unknown>): string | null {
  const dataText = asString(data.text)?.trim() ?? "";
  const noteTweet = asRecord(data.note_tweet);
  const noteTweetText = asString(noteTweet?.text)?.trim() ?? "";
  const articleText = resolveXurlArticleText(asRecord(data.article)) ?? "";
  const candidates = [dataText, noteTweetText, articleText].filter((value) => value.length > 0);
  if (candidates.length === 0) return null;
  return candidates.sort((left, right) => right.length - left.length)[0] ?? null;
}

function parseXurlTweetPayload(raw: unknown): BirdTweetPayload {
  const root = asRecord(raw);
  const errors = asArray(root?.errors);
  if (errors && errors.length > 0) {
    const first = asRecord(errors[0]);
    const message = asString(first?.message);
    if (message) throw new Error(`xurl API error: ${message}`);
  }

  const data = asRecord(root?.data);
  if (!data) {
    throw new Error("xurl read returned invalid payload");
  }

  const text = resolveXurlTweetText(data);
  if (!text) {
    throw new Error("xurl read returned invalid payload");
  }

  const includes = asRecord(root?.includes);
  const users = asArray(includes?.users) ?? [];
  const authorId = asString(data.author_id);
  const authorRecord =
    users.map((entry) => asRecord(entry)).find((entry) => asString(entry?.id) === authorId) ?? null;

  return {
    id: asString(data.id) ?? undefined,
    text,
    author:
      authorRecord && (asString(authorRecord.username) || asString(authorRecord.name))
        ? {
            username: asString(authorRecord.username) ?? undefined,
            name: asString(authorRecord.name) ?? undefined,
          }
        : undefined,
    createdAt: asString(data.created_at) ?? undefined,
    media: extractMediaFromXurlRaw(raw),
    client: "xurl",
  };
}

function execTweetCli(
  binary: string,
  args: string[],
  timeoutMs: number,
  env: Record<string, string | undefined>,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const toText = (value: string | Buffer | null | undefined) =>
      typeof value === "string" ? value : value ? value.toString("utf8") : "";

    execFileTracked(
      binary,
      args,
      {
        timeout: timeoutMs,
        env: { ...process.env, ...env },
        maxBuffer: 1024 * 1024,
      },
      (error, stdout, stderr) => {
        const stdoutText = toText(stdout).trim();
        const stderrText = stripAnsi(toText(stderr)).trim();
        if (error) {
          const detail = stderrText || stdoutText;
          const suffix = detail ? `: ${detail}` : "";
          reject(new Error(`${binary} read failed${suffix}`));
          return;
        }
        resolve(stdoutText);
      },
    );
  });
}

export async function readTweetWithXurl(args: {
  url: string;
  timeoutMs: number;
  env: Record<string, string | undefined>;
}): Promise<BirdTweetPayload> {
  const tweetId = parseTweetId(args.url);
  if (!tweetId) {
    throw new Error("xurl read requires a tweet status URL or id");
  }
  const stdout = await execTweetCli(
    "xurl",
    [buildXurlTweetEndpoint(tweetId)],
    args.timeoutMs,
    args.env,
  );
  if (!stdout) {
    throw new Error("xurl read returned empty output");
  }
  try {
    return parseXurlTweetPayload(JSON.parse(stdout));
  } catch (parseError) {
    if (
      parseError instanceof Error &&
      (parseError.message.startsWith("xurl read returned") ||
        parseError.message.startsWith("xurl API error"))
    ) {
      throw parseError;
    }
    const message = parseError instanceof Error ? parseError.message : String(parseError);
    throw new Error(`xurl read returned invalid JSON: ${message}`);
  }
}

export async function readTweetWithBird(args: {
  url: string;
  timeoutMs: number;
  env: Record<string, string | undefined>;
}): Promise<BirdTweetPayload> {
  const stdout = await execTweetCli(
    "bird",
    ["read", args.url, "--json-full"],
    args.timeoutMs,
    args.env,
  );
  if (!stdout) {
    throw new Error("bird read returned empty output");
  }
  try {
    const parsed = JSON.parse(stdout) as
      | (BirdTweetPayload & { _raw?: unknown })
      | Array<BirdTweetPayload & { _raw?: unknown }>;
    const tweet = Array.isArray(parsed) ? parsed[0] : parsed;
    if (!tweet || typeof tweet.text !== "string") {
      throw new Error("bird read returned invalid payload");
    }
    const { _raw, ...rest } = tweet as BirdTweetPayload & { _raw?: unknown };
    const media = extractMediaFromBirdRaw(_raw);
    return { ...rest, media, client: "bird" };
  } catch (parseError) {
    if (parseError instanceof Error && parseError.message.startsWith("bird read returned")) {
      throw parseError;
    }
    const message = parseError instanceof Error ? parseError.message : String(parseError);
    throw new Error(`bird read returned invalid JSON: ${message}`);
  }
}

export async function readTweetWithPreferredClient(args: {
  url: string;
  timeoutMs: number;
  env: Record<string, string | undefined>;
}): Promise<BirdTweetPayload> {
  const attempts: Array<[TweetCliClient, () => Promise<BirdTweetPayload>]> = [];
  if (hasXurlCli(args.env)) {
    attempts.push(["xurl", () => readTweetWithXurl(args)]);
  }
  if (hasBirdCli(args.env)) {
    attempts.push(["bird", () => readTweetWithBird(args)]);
  }

  const errors: string[] = [];
  for (const [client, run] of attempts) {
    try {
      const tweet = await run();
      return { ...tweet, client };
    } catch (error) {
      errors.push(`${client}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (errors.length > 0) {
    throw new Error(errors.join("; "));
  }
  throw new Error("No X CLI available");
}

export function withBirdTip(
  error: unknown,
  url: string | null,
  env: Record<string, string | undefined>,
): Error {
  if (!url || !isTwitterStatusUrl(url) || hasXurlCli(env) || hasBirdCli(env)) {
    return error instanceof Error ? error : new Error(String(error));
  }
  const message = error instanceof Error ? error.message : String(error);
  const combined = `${message}\n${BIRD_TIP}`;
  return error instanceof Error ? new Error(combined, { cause: error }) : new Error(combined);
}
