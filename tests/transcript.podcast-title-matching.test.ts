import { describe, expect, it, vi } from "vitest";
import { fetchTranscript } from "../packages/core/src/content/transcript/providers/podcast.js";
import {
  resolvePodcastEpisodeFromItunesSearch,
  resolvePodcastFeedUrlFromItunesSearch,
} from "../packages/core/src/content/transcript/providers/podcast/itunes.js";
import {
  extractEnclosureForEpisode,
  normalizeLooseTitle,
} from "../packages/core/src/content/transcript/providers/podcast/rss-feed.js";
import { tryFetchTranscriptFromFeedXml } from "../packages/core/src/content/transcript/providers/podcast/rss-transcript.js";

const transcriptBase = "https://93.184.216.34";
function feed(titles: string[]) {
  return `<?xml version="1.0"?><rss version="2.0" xmlns:podcast="https://podcastindex.org/namespace/1.0"><channel>${titles
    .map(
      (title, index) =>
        `<item><title>${title}</title><enclosure url="https://example.com/${index}.mp3"/><podcast:transcript url="${transcriptBase}/${index}.txt" type="text/plain"/></item>`,
    )
    .join("")}</channel></rss>`;
}

const distinctTitles = [
  ["城市生活", "宇宙探索"],
  ["城市 12", "宇宙 12"],
  ["か", "が"],
  ["и", "й"],
  ["مدينة", "علوم"],
  ["कल", "कला"],
  ["क", "क्"],
];

describe("podcast title matching", () => {
  it.each(distinctTitles)("selects %s and %s as distinct episodes", async (first, target) => {
    const xml = feed([first, target]);
    expect(extractEnclosureForEpisode(xml, target)?.enclosureUrl).toBe("https://example.com/1.mp3");
    const fetchImpl = vi.fn(async () => new Response("Requested episode"));
    const result = await tryFetchTranscriptFromFeedXml({
      fetchImpl,
      feedXml: xml,
      episodeTitle: target,
      notes: [],
    });
    expect(result?.transcriptUrl).toBe(`${transcriptBase}/1.txt`);
    expect(fetchImpl.mock.calls).toHaveLength(1);
  });

  it.each([
    ["Café Ünicode", "Cafe Unicode"],
    ["Hello – World", "hello - world"],
    ["が", "か\u3099"],
    ["й", "и\u0306"],
  ])("preserves equivalent titles %s and %s", (first, target) => {
    expect(extractEnclosureForEpisode(feed([first]), target)?.enclosureUrl).toBe(
      "https://example.com/0.mp3",
    );
  });

  it.each(["", "   ", "!!!", "😀", "\u0301", "不存在的标题"])(
    "does not select an arbitrary episode for explicit title %j",
    async (target) => {
      const xml = feed(["😀", "城市生活"]);
      expect(extractEnclosureForEpisode(xml, target)).toBeNull();
      const fetchImpl = vi.fn(async () => new Response("Wrong episode"));
      expect(
        await tryFetchTranscriptFromFeedXml({
          fetchImpl,
          feedXml: xml,
          episodeTitle: target,
          notes: [],
        }),
      ).toBeNull();
      expect(fetchImpl).not.toHaveBeenCalled();
    },
  );

  it("still selects the first transcript when no episode title was requested", async () => {
    const result = await tryFetchTranscriptFromFeedXml({
      fetchImpl: async () => new Response("First episode"),
      feedXml: feed(["城市生活", "宇宙探索"]),
      episodeTitle: null,
      notes: [],
    });
    expect(result?.transcriptUrl).toBe(`${transcriptBase}/0.txt`);
  });

  it("normalizes mark-only titles to an empty key", () => {
    expect(normalizeLooseTitle("\u0301")).toBe("");
  });

  it("selects later Unicode show and episode search matches", async () => {
    const fetchShows = async () =>
      Response.json({
        results: [
          { collectionName: "城市生活", feedUrl: "https://example.com/wrong.xml" },
          { collectionName: "宇宙探索", feedUrl: "https://example.com/target.xml" },
        ],
      });
    expect(await resolvePodcastFeedUrlFromItunesSearch(fetchShows, "宇宙探索")).toBe(
      "https://example.com/target.xml",
    );
    const fetchEpisodes = async () =>
      Response.json({
        results: [
          {
            collectionName: "城市生活",
            trackName: "宇宙探索",
            episodeUrl: "https://example.com/wrong-show.mp3",
          },
          {
            collectionName: "科学播客",
            trackName: "城市生活",
            episodeUrl: "https://example.com/wrong-episode.mp3",
          },
          {
            collectionName: "科学播客",
            trackName: "宇宙探索",
            episodeUrl: "https://example.com/target.mp3",
          },
        ],
      });
    expect(
      (await resolvePodcastEpisodeFromItunesSearch(fetchEpisodes, "科学播客", "宇宙探索"))
        ?.episodeUrl,
    ).toBe("https://example.com/target.mp3");
  });

  it("does not promote empty search keys above the existing first-result fallback", async () => {
    const fetchImpl = async () =>
      Response.json({
        results: [
          {
            collectionName: "First",
            trackName: "First",
            feedUrl: "https://example.com/first.xml",
            episodeUrl: "https://example.com/first.mp3",
          },
          {
            collectionName: "!!!",
            trackName: "!!!",
            feedUrl: "https://example.com/empty.xml",
            episodeUrl: "https://example.com/empty.mp3",
          },
        ],
      });
    expect(await resolvePodcastFeedUrlFromItunesSearch(fetchImpl, "😀")).toBe(
      "https://example.com/first.xml",
    );
    expect((await resolvePodcastEpisodeFromItunesSearch(fetchImpl, "😀", "😀"))?.episodeUrl).toBe(
      "https://example.com/first.mp3",
    );
  });

  it.each(["apple-html", "apple-lookup", "spotify"])(
    "returns the requested Chinese transcript through %s",
    async (path) => {
      const feedUrl = "https://example.com/feed.xml";
      const title = "宇宙探索";
      const calls: string[] = [];
      const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
        const url = input instanceof Request ? input.url : String(input);
        calls.push(url);
        if (url === feedUrl) return new Response(feed(["城市生活", title]));
        if (url.startsWith(transcriptBase))
          return new Response(url.endsWith("/1.txt") ? "Requested episode" : "Wrong episode");
        if (url.startsWith("https://itunes.apple.com/lookup"))
          return Response.json({
            results: [
              { wrapperType: "track", kind: "podcast", feedUrl },
              {
                wrapperType: "podcastEpisode",
                trackId: 456,
                trackName: title,
                episodeUrl: "https://example.com/1.mp3",
              },
            ],
          });
        if (url.startsWith("https://itunes.apple.com/search"))
          return Response.json({ results: [{ collectionName: "科学播客", feedUrl }] });
        if (url.startsWith("https://open.spotify.com/embed/"))
          return new Response(
            `<script id="__NEXT_DATA__">${JSON.stringify({ props: { pageProps: { state: { data: { entity: { title, subtitle: "科学播客" } } } } } })}</script>`,
          );
        throw new Error(`Unexpected fetch: ${url}`);
      });
      const result = await fetchTranscript(
        {
          url:
            path === "spotify"
              ? "https://open.spotify.com/episode/abc"
              : "https://podcasts.apple.com/us/podcast/test/id123?i=456",
          html:
            path === "apple-html"
              ? `<html><meta name="apple:title" content="${title}"><script>{"feedUrl":"${feedUrl}"}</script></html>`
              : null,
          resourceKey: null,
        },
        {
          fetch: fetchImpl,
          scrapeWithFirecrawl: null,
          apifyApiToken: null,
          youtubeTranscriptMode: "auto",
          ytDlpPath: null,
          groqApiKey: null,
          falApiKey: null,
          openaiApiKey: null,
        },
      );
      expect(result.text).toBe("Requested episode");
      expect(result.source).toBe("podcastTranscript");
      expect(result.metadata?.episodeTitle).toBe(title);
      expect(result.metadata?.transcriptUrl).toBe(`${transcriptBase}/1.txt`);
      expect(calls).not.toContain(`${transcriptBase}/0.txt`);
    },
  );
});
