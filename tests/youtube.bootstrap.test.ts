import { describe, expect, it } from "vitest";
import { extractYouTubeShortDescription } from "../packages/core/src/content/link-preview/content/youtube.js";
import {
  extractInitialPlayerResponse,
  extractYoutubeBootstrapConfig,
} from "../packages/core/src/content/transcript/utils.js";

describe("YouTube bootstrap parsing", () => {
  it("shares balanced parsing for nested objects, quoted braces, and escapes", () => {
    const description = String.raw`Quoted "}" and '{' with a backslash \\ stay literal.`;
    const payload = {
      videoDetails: { shortDescription: description },
      nested: { values: [{ key: "value" }] },
    };
    const json = JSON.stringify(payload);
    const html = `<script>var ytInitialPlayerResponse = ${json}; ignored({});</script>`;

    expect(extractInitialPlayerResponse(html)).toEqual(payload);
    expect(extractYoutubeBootstrapConfig(`<script>ytcfg.set(${json});</script>`)).toEqual(payload);
    expect(extractYouTubeShortDescription(html)).toBe(description);
  });

  it.each([
    "no player response",
    'ytInitialPlayerResponse {"videoDetails":{}}',
    "ytInitialPlayerResponse = null;",
    "ytInitialPlayerResponse = {broken};",
    "ytInitialPlayerResponse = {'single': '}'};",
    'ytInitialPlayerResponse = {"videoDetails":{"shortDescription":"unterminated}',
  ])("rejects missing or malformed player data: %s", (html) => {
    expect(extractInitialPlayerResponse(html)).toBeNull();
    expect(extractYouTubeShortDescription(html)).toBeNull();
  });

  it("keeps the first player assignment authoritative", () => {
    expect(
      extractInitialPlayerResponse(
        'ytInitialPlayerResponse = {bad}; ytInitialPlayerResponse = {"ok":true};',
      ),
    ).toBeNull();
  });

  it("continues to later bootstrap calls after malformed JSON", () => {
    expect(extractYoutubeBootstrapConfig('ytcfg.set({bad}); ytcfg.set({"ok":true});')).toEqual({
      ok: true,
    });
  });

  it.each([{}, { videoDetails: null }, { videoDetails: { shortDescription: 12 } }])(
    "ignores absent or non-text short descriptions",
    (payload) => {
      expect(
        extractYouTubeShortDescription(`ytInitialPlayerResponse = ${JSON.stringify(payload)};`),
      ).toBeNull();
    },
  );

  it("normalizes description whitespace", () => {
    expect(
      extractYouTubeShortDescription(
        'ytInitialPlayerResponse = {"videoDetails":{"shortDescription":"  First\\n\\n second  "}};',
      ),
    ).toBe("First\nsecond");
  });

  it("parses nested ytcfg.set objects (balanced braces)", () => {
    const html = `
      <html><head>
      <script>window.ytcfg.set('EMERGENCY_BASE_URL','/error_204');</script>
      <script>ytcfg.set({"INNERTUBE_API_KEY":"TEST_KEY","INNERTUBE_CONTEXT":{"client":{"clientName":"WEB","clientVersion":"1.0"}},"EXPERIMENT_FLAGS":{"nested":{"a":1,"b":{"c":2}}}});</script>
      </head><body></body></html>
    `.trim();

    const config = extractYoutubeBootstrapConfig(html);
    expect(config).not.toBeNull();
    expect(config?.INNERTUBE_API_KEY).toBe("TEST_KEY");
    expect(config?.INNERTUBE_CONTEXT).toEqual(
      expect.objectContaining({
        client: expect.objectContaining({ clientName: "WEB" }),
      }),
    );
  });
});
