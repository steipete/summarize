import { isTwitterStatusUrl } from "@steipete/summarize-core/content/url";
import { CliError, cliMessage, type CliMessage } from "../locale.js";
import { execTweetCli } from "./bird/exec.js";
import { parseBirdTweetPayload, parseXurlTweetPayload } from "./bird/parse.js";
import type { BirdTweetPayload, TweetCliClient } from "./bird/types.js";
import { TWITTER_HOSTS } from "./constants.js";
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
    throw new CliError("error.xurlInput");
  }
  const stdout = await execTweetCli(
    "xurl",
    [buildXurlTweetEndpoint(tweetId)],
    args.timeoutMs,
    args.env,
  );
  if (!stdout) {
    throw new CliError("error.xurlEmpty");
  }
  try {
    return parseXurlTweetPayload(JSON.parse(stdout));
  } catch (parseError) {
    if (
      parseError instanceof Error &&
      (parseError.message.startsWith(
        /* i18n-ignore: CliError.message is a stable English API diagnostic. */ "xurl read returned",
      ) ||
        parseError.message.startsWith(
          /* i18n-ignore: CliError.message is a stable English API diagnostic. */ "xurl API error",
        ))
    ) {
      throw parseError;
    }
    const message = parseError instanceof Error ? parseError.message : String(parseError);
    throw new CliError("error.xurlJson", { message: String(message) });
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
    throw new CliError("error.birdEmpty");
  }
  try {
    return parseBirdTweetPayload(JSON.parse(stdout));
  } catch (parseError) {
    if (
      parseError instanceof Error &&
      parseError.message.startsWith(
        /* i18n-ignore: CliError.message is a stable English API diagnostic. */ "bird read returned",
      )
    ) {
      throw parseError;
    }
    const message = parseError instanceof Error ? parseError.message : String(parseError);
    throw new CliError("error.birdJson", { message: String(message) });
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

  let failure: CliMessage | undefined;
  for (const [client, run] of attempts) {
    try {
      const tweet = await run();
      return { ...tweet, client };
    } catch (error) {
      const next = cliMessage("error.tweetClient", {
        client,
        error:
          error instanceof CliError
            ? error.descriptor()
            : error instanceof Error
              ? error.message
              : String(error),
      });
      failure = failure ? cliMessage("error.sequence", { first: failure, next }) : next;
    }
  }

  if (failure) {
    throw new CliError(failure.key, failure.values);
  }
  throw new CliError("error.noTwitterCli");
}

export function withBirdTip(
  error: unknown,
  url: string | null,
  env: Record<string, string | undefined>,
): Error {
  if (!url || !isTwitterStatusUrl(url) || hasXurlCli(env) || hasBirdCli(env)) {
    return error instanceof Error ? error : new Error(String(error));
  }
  return new CliError(
    "error.withTwitterTip",
    {
      message:
        error instanceof CliError
          ? error.descriptor()
          : error instanceof Error
            ? error.message
            : String(error),
    },
    error instanceof Error ? { cause: error } : undefined,
  );
}
