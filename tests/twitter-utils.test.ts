import { describe, expect, it } from "vitest";
import {
  extractTweetId,
  isAnubisHtml,
  isBlockedTwitterContent,
  toNitterUrls,
  toTwitterSyndicationUrl,
} from "../packages/core/src/content/link-preview/content/twitter-utils.js";

describe("extractTweetId", () => {
  it("extracts status ID from valid x.com and twitter.com URLs", () => {
    expect(extractTweetId("https://x.com/user/status/2094533934960758909")).toBe(
      "2094533934960758909",
    );
    expect(extractTweetId("https://twitter.com/user/status/1234567890?s=20")).toBe("1234567890");
    expect(extractTweetId("https://mobile.twitter.com/user/status/9876543210")).toBe("9876543210");
  });

  it("returns null for non-status or invalid URLs", () => {
    expect(extractTweetId("https://x.com/user")).toBeNull();
    expect(extractTweetId("https://example.com/user/status/123")).toBeNull();
    expect(extractTweetId("not-a-url")).toBeNull();
  });
});

describe("toTwitterSyndicationUrl", () => {
  it("builds expected syndication API endpoint URL", () => {
    expect(toTwitterSyndicationUrl("2094533934960758909")).toBe(
      "https://cdn.syndication.twimg.com/tweet-result?id=2094533934960758909&token=123",
    );
  });
});

describe("isBlockedTwitterContent", () => {
  it("detects Nitter C&D and offline landing pages", () => {
    expect(isBlockedTwitterContent("nitter.net is offline")).toBe(true);
    expect(isBlockedTwitterContent("Received cease-and-desist notice")).toBe(true);
    expect(isBlockedTwitterContent("Nitter development stopped due to Twitter API changes")).toBe(
      true,
    );
  });

  it("returns false for legitimate tweet content", () => {
    expect(isBlockedTwitterContent("This is a legitimate summary of a tweet.")).toBe(false);
  });
});

describe("toNitterUrls", () => {
  it("returns empty for non-twitter urls", () => {
    expect(toNitterUrls("https://example.com")).toEqual([]);
  });

  it("returns a stable rotated list for twitter status urls", () => {
    const url = "https://x.com/user/status/123";
    const first = toNitterUrls(url);
    const second = toNitterUrls(url);

    expect(first).toEqual(second);
    expect(first.length).toBeGreaterThan(1);

    const hosts = new Set(first.map((item) => new URL(item).host));
    expect(hosts.size).toBe(first.length);

    for (const item of first) {
      expect(new URL(item).pathname).toBe("/user/status/123");
    }
  });
});

describe("isAnubisHtml", () => {
  it("detects Anubis challenge pages", () => {
    const html =
      "<html><body>Anubis – Proof-of-Work challenge. JShelter blocks this.</body></html>";
    expect(isAnubisHtml(html)).toBe(true);
  });

  it("does not flag unrelated content", () => {
    const html = "<html><body>Normal tweet content.</body></html>";
    expect(isAnubisHtml(html)).toBe(false);
  });
});
