import { CliError } from "../../locale.js";
import { extractMediaFromBirdRaw, extractMediaFromXurlRaw } from "./media.js";
import type { BirdTweetPayload } from "./types.js";

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" ? (value as Record<string, unknown>) : null;

const asArray = (value: unknown): unknown[] | null => (Array.isArray(value) ? value : null);

const asString = (value: unknown): string | null => (typeof value === "string" ? value : null);

const asNumber = (value: unknown): number | null => (typeof value === "number" ? value : null);

function resolveXurlTopLevelError(root: Record<string, unknown> | null): CliError | null {
  if (!root) return null;
  const status = asNumber(root.status);
  const title = asString(root.title)?.trim();
  const detail = asString(root.detail)?.trim();
  if (!status && !title && !detail) return null;

  const label = detail || title || "";
  const unauthorized =
    status === 401 || /* i18n-ignore: External X API diagnostic. */ /unauthorized/i.test(label);
  return new CliError("error.xurlTopLevel", {
    message: label,
    hasMessage: Boolean(label),
    status: status ?? 0,
    hasStatus: Boolean(status),
    unauthorized,
  });
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

export function parseXurlTweetPayload(raw: unknown): BirdTweetPayload {
  const root = asRecord(raw);
  const topLevelError = resolveXurlTopLevelError(root);
  if (topLevelError) throw topLevelError;

  const errors = asArray(root?.errors);
  if (errors && errors.length > 0) {
    const first = asRecord(errors[0]);
    const message = asString(first?.message);
    if (message) throw new CliError("error.xurlApi", { message: String(message) });
  }

  const data = asRecord(root?.data);
  if (!data) {
    throw new CliError("error.xurlPayload");
  }

  const text = resolveXurlTweetText(data);
  if (!text) {
    throw new CliError("error.xurlPayload");
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

export function parseBirdTweetPayload(raw: unknown): BirdTweetPayload {
  const parsed = raw as
    | (BirdTweetPayload & { _raw?: unknown })
    | Array<BirdTweetPayload & { _raw?: unknown }>;
  const tweet = Array.isArray(parsed) ? parsed[0] : parsed;
  if (!tweet || typeof tweet.text !== "string") {
    throw new CliError("error.birdPayload");
  }
  const { _raw, ...rest } = tweet as BirdTweetPayload & { _raw?: unknown };
  const media = extractMediaFromBirdRaw(_raw);
  return { ...rest, media, client: "bird" };
}
