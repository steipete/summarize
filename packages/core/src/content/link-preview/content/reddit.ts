import { parseHtmlDocument } from "../../html-document.js";
import { sanitizeHtmlForMarkdownConversion } from "./article.js";
import { normalizeCandidate } from "./cleaner.js";

const REDDIT_HOSTS = new Set([
  "reddit.com",
  "www.reddit.com",
  "new.reddit.com",
  "old.reddit.com",
  "np.reddit.com",
]);
const REDDIT_THREAD_PATH_PATTERN = /^\/(?:r\/[^/]+\/)?comments\/([a-z0-9]+)(?:\/|$)/i;
const REDDIT_VERIFICATION_PATTERN =
  /reddit\s*-\s*please wait for verification|please wait for verification|whoa there, pardner/i;

function parseRedditThreadUrl(input: string): URL | null {
  try {
    const url = new URL(input);
    if (!REDDIT_HOSTS.has(url.hostname.toLowerCase())) return null;
    if (!REDDIT_THREAD_PATH_PATTERN.test(url.pathname)) return null;
    return url;
  } catch {
    return null;
  }
}

function redditThreadId(url: URL): string | null {
  return url.pathname.match(REDDIT_THREAD_PATH_PATTERN)?.[1]?.toLowerCase() ?? null;
}

export function toOldRedditThreadUrl(input: string): string | null {
  const url = parseRedditThreadUrl(input);
  if (!url) return null;
  url.protocol = "https:";
  url.hostname = "old.reddit.com";
  url.port = "";
  return url.href;
}

export function isBlockedRedditThreadHtml(inputUrl: string, html: string): boolean {
  const redditUrl = parseRedditThreadUrl(inputUrl);
  if (!redditUrl) return false;

  const parsed = parseHtmlDocument(html, redditUrl.href);
  try {
    const threadId = redditThreadId(redditUrl);
    if (
      parsed.document.querySelector(
        `#thing_t3_${threadId}.thing[data-type="link"], .thing[data-fullname="t3_${threadId}"][data-type="link"], shreddit-post, [data-testid="post-container"]`,
      )
    ) {
      return false;
    }

    const title = normalizeCandidate(parsed.document.querySelector("title")?.textContent) ?? "";
    if (REDDIT_VERIFICATION_PATTERN.test(title)) return true;

    const body = normalizeCandidate(parsed.document.body?.textContent) ?? "";
    return body.length <= 1_000 && REDDIT_VERIFICATION_PATTERN.test(body);
  } finally {
    parsed.close();
  }
}

function directChildWithClass(element: Element, className: string): Element | null {
  return Array.from(element.children).find((child) => child.classList.contains(className)) ?? null;
}

function thingEntry(thing: Element): Element | null {
  return directChildWithClass(thing, "entry");
}

function entryBody(entry: Element | null): Element | null {
  return entry?.querySelector(".usertext-body .md") ?? null;
}

function safeBodyHtml(body: Element | null): string {
  return body ? sanitizeHtmlForMarkdownConversion(body.outerHTML) : "";
}

function commentDepth(comment: Element): number {
  let depth = 0;
  let ancestor = comment.parentElement;
  while (ancestor) {
    if (ancestor.classList.contains("thing") && ancestor.classList.contains("comment")) {
      depth += 1;
    }
    ancestor = ancestor.parentElement;
  }
  return depth;
}

function escapeHtml(input: string): string {
  return input
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function resolveHttpUrl(input: string | null | undefined, baseUrl: URL): string | null {
  if (!input) return null;
  try {
    const resolved = new URL(input, baseUrl);
    return resolved.protocol === "http:" || resolved.protocol === "https:" ? resolved.href : null;
  } catch {
    return null;
  }
}

export function normalizeOldRedditThreadHtml(
  inputUrl: string,
  html: string,
  options?: { canonicalUrl?: string },
): string | null {
  const redditUrl = parseRedditThreadUrl(inputUrl);
  if (!redditUrl) return null;

  const parsed = parseHtmlDocument(html, redditUrl.href);
  try {
    const threadId = redditThreadId(redditUrl);
    if (!threadId) return null;
    const post = parsed.document.querySelector(
      `#thing_t3_${threadId}.thing[data-type="link"], .thing[data-fullname="t3_${threadId}"][data-type="link"]`,
    );
    if (!post || post.classList.contains("promoted")) return null;

    const postEntry = thingEntry(post);
    const titleLink = postEntry?.querySelector("a.title") ?? null;
    const title = normalizeCandidate(titleLink?.textContent) ?? null;
    if (!title) return null;
    const isSelfPost =
      post.classList.contains("self") ||
      (post.getAttribute("data-domain") ?? "").toLowerCase().startsWith("self.");
    const titleUrl = resolveHttpUrl(
      isSelfPost && options?.canonicalUrl ? options.canonicalUrl : titleLink?.getAttribute("href"),
      redditUrl,
    );

    const postAuthor = normalizeCandidate(
      postEntry?.querySelector(".tagline .author")?.textContent,
    );
    const subreddit = normalizeCandidate(post.getAttribute("data-subreddit"));
    const postBody = safeBodyHtml(entryBody(postEntry));
    const postByline = [postAuthor ? `u/${postAuthor}` : null, subreddit ? `r/${subreddit}` : null]
      .filter(Boolean)
      .join(" in ");

    const commentSections: string[] = [];
    for (const comment of parsed.document.querySelectorAll(".thing.comment")) {
      const entry = thingEntry(comment);
      const body = entryBody(entry);
      const bodyText = normalizeCandidate(body?.textContent);
      if (!bodyText) continue;

      const author = normalizeCandidate(entry?.querySelector(".tagline .author")?.textContent);
      const headingLevel = Math.min(6, 3 + commentDepth(comment));
      const heading = author ? `Comment by u/${author}` : "Comment";
      commentSections.push(
        `<section><h${headingLevel}>${escapeHtml(heading)}</h${headingLevel}>${safeBodyHtml(body)}</section>`,
      );
    }

    const bylineHtml = postByline ? `<p>Posted by ${escapeHtml(postByline)}</p>` : "";
    const commentsHtml =
      commentSections.length > 0 ? `<h2>Comments</h2>${commentSections.join("")}` : "";
    const titleHtml = titleUrl
      ? `<a href="${escapeHtml(titleUrl)}">${escapeHtml(title)}</a>`
      : escapeHtml(title);
    const outboundLinkHtml =
      titleUrl && !isSelfPost
        ? `<p>Link: <a href="${escapeHtml(titleUrl)}">${escapeHtml(titleUrl)}</a></p>`
        : "";
    return `<!doctype html><html><head><title>${escapeHtml(title)}</title><meta property="og:site_name" content="Reddit"></head><body><article><h1>${titleHtml}</h1>${bylineHtml}${outboundLinkHtml}${postBody}${commentsHtml}</article></body></html>`;
  } finally {
    parsed.close();
  }
}
