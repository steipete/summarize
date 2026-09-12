import { isTwitterStatusUrl } from "@steipete/summarize-core/content/url";
import { execTweetCli } from "./bird/exec.js";
import { parseBirdTweetPayload, parseXurlTweetPayload } from "./bird/parse.js";
import type { BirdTweetPayload, TweetCliClient } from "./bird/types.js";
import { BIRD_TIP, TWITTER_HOSTS } from "./constants.js";
import { hasBirdCli, hasXurlCli } from "./env.js";

export type { TweetCliClient } from "./bird/types.js";

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

function buildXurlTweetEndpoint(tweetId: string): string {
  const params = new URLSearchParams({
    expansions: "author_id,attachments.media_keys",
    "tweet.fields": "created_at,attachments,entities,note_tweet,article",
    "user.fields": "username,name",
    "media.fields": "type,url,preview_image_url,variants",
  });
  return `/2/tweets/${tweetId}?${params.toString()}`;
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
    return parseBirdTweetPayload(JSON.parse(stdout));
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
