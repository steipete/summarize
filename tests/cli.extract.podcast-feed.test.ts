import { describe, expect, it, vi } from "vitest";
import { runCli } from "../src/run.js";
import { captureStream } from "./helpers/streams.js";

describe("CLI podcast feed extraction", () => {
  it("follows published RSS transcripts instead of printing the feed XML", async () => {
    const feedUrl = "https://example.com/podcast.xml";
    const transcriptUrl = "http://93.184.216.34/episode.vtt";
    const feed = `<?xml version="1.0"?><rss version="2.0" xmlns:podcast="https://podcastindex.org/namespace/1.0"><channel><title>Test podcast</title><item><title>Beacon-731</title><podcast:transcript url="${transcriptUrl}" type="text/vtt"/></item></channel></rss>`;
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url === feedUrl)
        return new Response(feed, { headers: { "content-type": "application/xml" } });
      if (url === transcriptUrl)
        return new Response(
          "WEBVTT\n\n00:00:00.000 --> 00:00:02.000\nSeventeen sensors are ready at North Pier.\n",
          { headers: { "content-type": "text/vtt" } },
        );
      throw new Error(`Unexpected fetch: ${url}`);
    });
    const stdout = captureStream();
    await runCli([feedUrl, "--extract", "--plain", "--timeout", "2s"], {
      env: {},
      fetch: fetchImpl,
      stdout: stdout.stream,
      stderr: captureStream().stream,
    });
    expect(fetchImpl).toHaveBeenCalledWith(transcriptUrl, expect.anything());
    expect(stdout.getText()).toContain("Seventeen sensors are ready at North Pier.");
    expect(stdout.getText()).not.toContain("<rss");
  });
});
