import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { createLinkPreviewClient } from "../src/content/index.js";
import { readTweetWithPreferredClient } from "../src/run/bird.js";
import { resolveExecutableInPath } from "../src/run/env.js";

const ENV = process.env as Record<string, string | undefined>;
const XURL_PATH = resolveExecutableInPath("xurl", ENV);
const LIVE = process.env.SUMMARIZE_LIVE_TESTS === "1" && Boolean(XURL_PATH);

type MeResponse = { data?: { id?: string; username?: string } };
type TimelineTweet = {
  id?: string;
  attachments?: { media_keys?: string[] };
};
type TimelineResponse = {
  data?: TimelineTweet[];
  includes?: { media?: Array<{ media_key?: string; type?: string }> };
};

function readJson<T>(endpoint: string): T {
  const stdout = execFileSync("xurl", [endpoint], {
    env: ENV,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return JSON.parse(stdout) as T;
}

function resolveLiveIdentity(): { userId: string; username: string } {
  const me = readJson<MeResponse>("/2/users/me");
  const userId = me.data?.id;
  const username = me.data?.username;
  if (!userId || !username) {
    throw new Error("xurl live test could not resolve /2/users/me");
  }
  return { userId, username };
}

function resolveRecentTweets(): { username: string; tweets: TimelineTweet[]; mediaByKey: Map<string, string> } {
  const { userId, username } = resolveLiveIdentity();
  const timeline = readJson<TimelineResponse>(
    `/2/users/${userId}/tweets?max_results=20&exclude=retweets,replies&expansions=attachments.media_keys&tweet.fields=attachments&media.fields=type`,
  );
  const tweets = timeline.data ?? [];
  const mediaByKey = new Map<string, string>();
  for (const media of timeline.includes?.media ?? []) {
    if (typeof media.media_key === "string" && typeof media.type === "string") {
      mediaByKey.set(media.media_key, media.type);
    }
  }
  return { username, tweets, mediaByKey };
}

function resolveLiveTweetUrl(): string {
  const { username, tweets } = resolveRecentTweets();
  const tweetId =
    tweets.find(
      (tweet) =>
        typeof tweet.id === "string" && (tweet.attachments?.media_keys?.length ?? 0) === 0,
    )?.id ??
    tweets.find((tweet) => typeof tweet.id === "string" && tweet.id)?.id;
  if (!tweetId) {
    throw new Error("xurl live test could not find a recent tweet");
  }
  return `https://x.com/${username}/status/${tweetId}`;
}

function resolveLiveMediaTweetUrl(): string | null {
  const { username, tweets, mediaByKey } = resolveRecentTweets();
  const tweet = tweets.find((entry) =>
    (entry.attachments?.media_keys ?? []).some((key) => {
      const type = mediaByKey.get(key);
      return type === "video" || type === "animated_gif";
    }),
  );
  const tweetId = tweet?.id;
  return typeof tweetId === "string" ? `https://x.com/${username}/status/${tweetId}` : null;
}

const createClient = () =>
  createLinkPreviewClient({
    readTweetWithBird: ({ url, timeoutMs }) =>
      readTweetWithPreferredClient({ url, timeoutMs, env: ENV }),
  });

describe("live xurl tweet reader", () => {
  const run = LIVE ? it : it.skip;

  run(
    "prefers xurl for tweet extraction when it is installed and authenticated",
    async () => {
      const tweetUrl = resolveLiveTweetUrl();
      const result = await readTweetWithPreferredClient({
        url: tweetUrl,
        timeoutMs: 120_000,
        env: ENV,
      });

      expect(result.client).toBe("xurl");
      expect(result.text.trim().length).toBeGreaterThan(10);
    },
    180_000,
  );

  run(
    "uses xurl inside link preview extraction for regular tweets",
    async () => {
      const tweetUrl = resolveLiveTweetUrl();
      const client = createClient();
      const result = await client.fetchLinkContent(tweetUrl, { format: "text" });

      expect(result.diagnostics.strategy).toBe("xurl");
      expect(result.content.trim().length).toBeGreaterThan(10);
    },
    180_000,
  );

  run(
    "resolves media urls from xurl for recent video tweets when available",
    async () => {
      const mediaTweetUrl = resolveLiveMediaTweetUrl();
      if (!mediaTweetUrl) return;

      const result = await readTweetWithPreferredClient({
        url: mediaTweetUrl,
        timeoutMs: 120_000,
        env: ENV,
      });

      expect(result.client).toBe("xurl");
      expect(result.media?.preferredUrl ?? result.media?.urls?.[0]).toMatch(/^https:\/\/video\.twimg\.com\//);
    },
    180_000,
  );
});
