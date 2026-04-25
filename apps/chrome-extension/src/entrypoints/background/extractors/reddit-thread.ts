import type { Extractor, ExtractorContext, ExtractorResult } from "./types";

type RedditThing<TKind extends string, TData> = {
  kind: TKind;
  data: TData;
};

type RedditListing = RedditThing<
  "Listing",
  {
    children: RedditChild[];
  }
>;

type RedditPost = RedditThing<
  "t3",
  {
    author?: string;
    created_utc?: number;
    num_comments?: number;
    score?: number;
    selftext?: string;
    subreddit?: string;
    title?: string;
  }
>;

type RedditComment = RedditThing<
  "t1",
  {
    author?: string;
    body?: string;
    created_utc?: number;
    replies?: RedditListing | "";
    score?: number;
  }
>;

type RedditChild = RedditPost | RedditComment | RedditThing<string, Record<string, unknown>>;

type RedditThreadRoute = {
  subreddit: string;
  postId: string;
  jsonUrl: string;
};

const MAX_COMMENT_CHARS = 2_000;
const MAX_COMMENTS = 160;
const MAX_DEPTH = 6;
const TRUNCATED_MARKER = "\n\n[TRUNCATED]";

function getRedditThreadRoute(url: string): RedditThreadRoute | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }

  const host = parsed.hostname.toLowerCase();
  if (host !== "reddit.com" && !host.endsWith(".reddit.com")) return null;

  const parts = parsed.pathname.split("/").filter(Boolean);
  const subredditIndex = parts.findIndex((part) => part.toLowerCase() === "r");
  if (subredditIndex < 0) return null;
  if (parts[subredditIndex + 2]?.toLowerCase() !== "comments") return null;

  const subreddit = parts[subredditIndex + 1];
  const postId = parts[subredditIndex + 3];
  if (!subreddit || !postId) return null;

  return {
    subreddit,
    postId,
    jsonUrl: `https://www.reddit.com/r/${encodeURIComponent(
      subreddit,
    )}/comments/${encodeURIComponent(postId)}.json`,
  };
}

function isListing(value: unknown): value is RedditListing {
  return (
    Boolean(value) &&
    typeof value === "object" &&
    (value as { kind?: unknown }).kind === "Listing" &&
    Array.isArray((value as { data?: { children?: unknown } }).data?.children)
  );
}

function isPost(value: unknown): value is RedditPost {
  return Boolean(value) && typeof value === "object" && (value as { kind?: unknown }).kind === "t3";
}

function isComment(value: unknown): value is RedditComment {
  return Boolean(value) && typeof value === "object" && (value as { kind?: unknown }).kind === "t1";
}

function formatDate(seconds: unknown): string {
  return typeof seconds === "number" && Number.isFinite(seconds)
    ? new Date(seconds * 1000).toISOString()
    : "unknown date";
}

function cleanText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function clampText(text: string, maxChars: number, state: { truncated: boolean }): string {
  if (text.length <= maxChars) return text;
  state.truncated = true;
  return `${text.slice(0, Math.max(0, maxChars - TRUNCATED_MARKER.length))}${TRUNCATED_MARKER}`;
}

function appendLine(
  lines: string[],
  line: string,
  state: { totalChars: number; truncated: boolean },
  maxChars: number,
) {
  if (state.totalChars >= maxChars) {
    state.truncated = true;
    return false;
  }

  const next = `${line}\n`;
  const remaining = maxChars - state.totalChars;
  if (next.length > remaining) {
    const marker = TRUNCATED_MARKER.trim();
    lines.push(`${next.slice(0, Math.max(0, remaining - marker.length - 1)).trimEnd()}\n${marker}`);
    state.totalChars = maxChars;
    state.truncated = true;
    return false;
  }

  lines.push(line);
  state.totalChars += next.length;
  return true;
}

function appendComment(
  lines: string[],
  comment: RedditComment,
  depth: number,
  state: { totalChars: number; truncated: boolean; comments: number },
  maxChars: number,
) {
  if (depth > MAX_DEPTH || state.comments >= MAX_COMMENTS) {
    state.truncated = true;
    return;
  }

  const data = comment.data;
  const body = cleanText(data.body);
  if (!body || body === "[deleted]" || body === "[removed]") return;

  state.comments += 1;
  const indent = "  ".repeat(depth);
  const score = typeof data.score === "number" && Number.isFinite(data.score) ? data.score : 0;
  const author = cleanText(data.author) || "[unknown]";
  const date = formatDate(data.created_utc);
  const bodyState = { truncated: false };
  const formattedBody = clampText(body.replace(/\n{3,}/g, "\n\n"), MAX_COMMENT_CHARS, bodyState);
  if (bodyState.truncated) state.truncated = true;

  if (
    !appendLine(
      lines,
      `${indent}[${date}] ${author} (score:${score}): ${formattedBody}`,
      state,
      maxChars,
    )
  ) {
    return;
  }

  const replies = data.replies;
  if (!replies || typeof replies === "string" || !isListing(replies)) return;
  for (const child of replies.data.children) {
    if (!isComment(child)) continue;
    appendComment(lines, child, depth + 1, state, maxChars);
    if (state.totalChars >= maxChars || state.comments >= MAX_COMMENTS) return;
  }
}

function parseThreadJson(value: unknown): { post: RedditPost; comments: RedditComment[] } | null {
  if (!Array.isArray(value) || value.length < 2) return null;
  const postListing = value[0];
  const commentsListing = value[1];
  if (!isListing(postListing) || !isListing(commentsListing)) return null;
  const post = postListing.data.children.find(isPost);
  if (!post) return null;
  const comments = commentsListing.data.children.filter(isComment);
  return { post, comments };
}

function formatThread(
  thread: { post: RedditPost; comments: RedditComment[] },
  fallback: { subreddit: string; title: string | null },
  maxChars: number,
) {
  const postData = thread.post.data;
  const state = { totalChars: 0, truncated: false, comments: 0 };
  const lines: string[] = [];
  const title = cleanText(postData.title) || fallback.title || "Reddit thread";
  const subreddit = cleanText(postData.subreddit) || fallback.subreddit;
  const author = cleanText(postData.author) || "[unknown]";
  const score =
    typeof postData.score === "number" && Number.isFinite(postData.score) ? postData.score : 0;
  const commentCount =
    typeof postData.num_comments === "number" && Number.isFinite(postData.num_comments)
      ? postData.num_comments
      : thread.comments.length;
  const postBody = cleanText(postData.selftext);

  appendLine(
    lines,
    `[${formatDate(postData.created_utc)}] ${author} posted in r/${subreddit} (score:${score})`,
    state,
    maxChars,
  );
  appendLine(lines, `Title: ${title}`, state, maxChars);
  appendLine(lines, `Comments: ${commentCount}`, state, maxChars);
  if (postBody) {
    appendLine(lines, "", state, maxChars);
    appendLine(lines, clampText(postBody, MAX_COMMENT_CHARS, state), state, maxChars);
  }
  appendLine(lines, "", state, maxChars);
  appendLine(lines, "--- Comments ---", state, maxChars);

  for (const comment of thread.comments) {
    appendComment(lines, comment, 0, state, maxChars);
    if (state.totalChars >= maxChars || state.comments >= MAX_COMMENTS) break;
  }

  return {
    title,
    text: lines.join("\n").trim(),
    truncated: state.truncated,
    comments: state.comments,
  };
}

export const redditThreadExtractor: Extractor = {
  name: "reddit-thread",
  match: (ctx: ExtractorContext) => Boolean(getRedditThreadRoute(ctx.url)),
  async extract(ctx: ExtractorContext): Promise<ExtractorResult | null> {
    const route = getRedditThreadRoute(ctx.url);
    if (!route) return null;

    const res = await ctx.fetchImpl(route.jsonUrl, {
      credentials: "include",
      headers: {
        accept: "application/json",
      },
      signal: ctx.signal,
    });
    if (!res.ok) return null;

    const thread = parseThreadJson(await res.json());
    if (!thread) return null;

    const formatted = formatThread(
      thread,
      { subreddit: route.subreddit, title: ctx.title },
      ctx.maxChars,
    );
    if (!formatted.text) return null;

    ctx.log("extractor.redditThread.parsed", {
      comments: formatted.comments,
      truncated: formatted.truncated,
    });

    return {
      source: "page",
      extracted: {
        ok: true,
        url: ctx.url,
        title: formatted.title,
        text: formatted.text,
        truncated: formatted.truncated,
        media: null,
      },
    };
  },
};
