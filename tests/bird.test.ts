import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  readTweetWithBird,
  readTweetWithPreferredClient,
  readTweetWithXurl,
  withBirdTip,
} from "../src/run/bird.js";
import { BIRD_TIP } from "../src/run/constants.js";

const makeCliScript = (binary: "bird" | "xurl", script: string) => {
  const root = mkdtempSync(join(tmpdir(), `summarize-${binary}-`));
  const binDir = join(root, "bin");
  mkdirSync(binDir, { recursive: true });
  const cliPath = join(binDir, binary);
  writeFileSync(cliPath, script, "utf8");
  chmodSync(cliPath, 0o755);
  return { root, binDir };
};

const scriptForJson = (payload: unknown) => {
  const json = JSON.stringify(payload);
  return `#!/bin/sh\necho '${json}'\n`;
};

describe("tweet CLI helpers", () => {
  it("reads tweets and extracts media from bird extended entities", async () => {
    const payload = {
      id: "1",
      text: "Hello from bird",
      _raw: {
        legacy: {
          extended_entities: {
            media: [
              { type: "photo" },
              {
                type: "audio",
                video_info: {
                  variants: [
                    { url: "not-a-url", content_type: "video/mp4", bitrate: 64 },
                    {
                      url: "https://video.twimg.com/low.mp4",
                      content_type: "video/mp4",
                      bitrate: 120,
                    },
                    {
                      url: "https://video.twimg.com/high.mp4",
                      content_type: "video/mp4",
                      bitrate: 240,
                    },
                    { url: "https://video.twimg.com/playlist.m3u8", content_type: "text/plain" },
                  ],
                },
              },
            ],
          },
        },
      },
    };
    const { binDir } = makeCliScript("bird", scriptForJson(payload));
    const result = await readTweetWithBird({
      url: "https://x.com/user/status/123",
      timeoutMs: 1000,
      env: { PATH: binDir },
    });

    expect(result.client).toBe("bird");
    expect(result.text).toBe("Hello from bird");
    expect(result.media?.source).toBe("extended_entities");
    expect(result.media?.kind).toBe("audio");
    expect(result.media?.preferredUrl).toBe("https://video.twimg.com/high.mp4");
    expect(result.media?.urls).toContain("https://video.twimg.com/low.mp4");
  });

  it("reads tweets and extracts media from xurl responses", async () => {
    const payload = {
      data: {
        id: "2",
        text: "Hello from xurl",
        created_at: "2026-03-07T00:00:00.000Z",
        author_id: "99",
        attachments: {
          media_keys: ["7_1"],
        },
      },
      includes: {
        users: [{ id: "99", username: "steipete", name: "Peter" }],
        media: [
          { media_key: "7_2", type: "photo", url: "https://pbs.twimg.com/ignored.jpg" },
          {
            media_key: "7_1",
            type: "video",
            variants: [
              {
                url: "https://video.twimg.com/low.mp4",
                content_type: "video/mp4",
                bit_rate: 64,
              },
              {
                url: "https://video.twimg.com/high.mp4",
                content_type: "video/mp4",
                bit_rate: 256,
              },
            ],
          },
        ],
      },
    };
    const { binDir } = makeCliScript("xurl", scriptForJson(payload));
    const result = await readTweetWithXurl({
      url: "https://x.com/steipete/status/2",
      timeoutMs: 1000,
      env: { PATH: binDir },
    });

    expect(result.client).toBe("xurl");
    expect(result.text).toBe("Hello from xurl");
    expect(result.author?.username).toBe("steipete");
    expect(result.media?.source).toBe("xurl");
    expect(result.media?.preferredUrl).toBe("https://video.twimg.com/high.mp4");
  });

  it("prefers long-form note_tweet or article text from xurl payloads", async () => {
    const noteTweetPayload = {
      data: {
        id: "5",
        text: "short teaser",
        note_tweet: {
          text: "This is the full long-form X post text that should win over the teaser.",
        },
        author_id: "99",
      },
      includes: {
        users: [{ id: "99", username: "steipete", name: "Peter" }],
      },
    };
    const { binDir: noteDir } = makeCliScript("xurl", scriptForJson(noteTweetPayload));
    const noteResult = await readTweetWithXurl({
      url: "https://x.com/steipete/status/5",
      timeoutMs: 1000,
      env: { PATH: noteDir },
    });
    expect(noteResult.text).toContain("full long-form X post text");

    const articlePayload = {
      data: {
        id: "6",
        text: "short teaser",
        article: {
          title: "Deep Dive",
          text: "Article body that should outrank the short teaser and preserve article content.",
        },
        author_id: "99",
      },
      includes: {
        users: [{ id: "99", username: "steipete", name: "Peter" }],
      },
    };
    const { binDir: articleDir } = makeCliScript("xurl", scriptForJson(articlePayload));
    const articleResult = await readTweetWithXurl({
      url: "https://x.com/steipete/status/6",
      timeoutMs: 1000,
      env: { PATH: articleDir },
    });
    expect(articleResult.text).toContain("Deep Dive");
    expect(articleResult.text).toContain("Article body");
  });

  it("prefers xurl when both CLIs are installed and falls back to bird on xurl failure", async () => {
    const root = mkdtempSync(join(tmpdir(), "summarize-tweet-cli-"));
    const binDir = join(root, "bin");
    mkdirSync(binDir, { recursive: true });

    writeFileSync(join(binDir, "xurl"), '#!/bin/sh\necho "xurl boom" 1>&2\nexit 1\n', "utf8");
    writeFileSync(
      join(binDir, "bird"),
      '#!/bin/sh\necho \'{"id":"3","text":"bird fallback","author":{"username":"birdy"}}\'\n',
      "utf8",
    );
    chmodSync(join(binDir, "xurl"), 0o755);
    chmodSync(join(binDir, "bird"), 0o755);

    const result = await readTweetWithPreferredClient({
      url: "https://x.com/user/status/3",
      timeoutMs: 1000,
      env: { PATH: binDir },
    });
    expect(result.client).toBe("bird");
    expect(result.text).toBe("bird fallback");

    writeFileSync(
      join(binDir, "xurl"),
      scriptForJson({
        data: { id: "4", text: "xurl wins", author_id: "9" },
        includes: { users: [{ id: "9", username: "xurl-user", name: "Xurl User" }] },
      }),
      "utf8",
    );
    chmodSync(join(binDir, "xurl"), 0o755);

    const preferred = await readTweetWithPreferredClient({
      url: "https://x.com/user/status/4",
      timeoutMs: 1000,
      env: { PATH: binDir },
    });
    expect(preferred.client).toBe("xurl");
    expect(preferred.text).toBe("xurl wins");
  });

  it("surfaces CLI errors, empty output, and invalid payloads", async () => {
    const { binDir: errorBird } = makeCliScript("bird", '#!/bin/sh\necho "boom" 1>&2\nexit 1\n');
    await expect(
      readTweetWithBird({
        url: "https://x.com/user/status/1",
        timeoutMs: 1000,
        env: { PATH: errorBird },
      }),
    ).rejects.toThrow(/bird read failed: boom/);

    const { binDir: emptyXurl } = makeCliScript("xurl", "#!/bin/sh\n");
    await expect(
      readTweetWithXurl({
        url: "https://x.com/user/status/1",
        timeoutMs: 1000,
        env: { PATH: emptyXurl },
      }),
    ).rejects.toThrow(/xurl read returned empty output/);

    const { binDir: invalidBird } = makeCliScript("bird", '#!/bin/sh\necho "not json"\n');
    await expect(
      readTweetWithBird({
        url: "https://x.com/user/status/1",
        timeoutMs: 1000,
        env: { PATH: invalidBird },
      }),
    ).rejects.toThrow(/bird read returned invalid JSON/);

    const { binDir: invalidXurl } = makeCliScript("xurl", scriptForJson({ data: { id: "1" } }));
    await expect(
      readTweetWithXurl({
        url: "https://x.com/user/status/1",
        timeoutMs: 1000,
        env: { PATH: invalidXurl },
      }),
    ).rejects.toThrow(/xurl read returned invalid payload/);
  });

  it("adds install tips only when neither xurl nor bird is available", () => {
    const baseError = new Error("nope");
    const url = "https://x.com/user/status/123";
    const tipError = withBirdTip(baseError, url, { PATH: "" });
    expect(tipError.message).toContain(BIRD_TIP);

    const { binDir } = makeCliScript("xurl", "#!/bin/sh\nexit 0\n");
    const noTip = withBirdTip(baseError, url, { PATH: binDir });
    expect(noTip.message).toBe(baseError.message);

    const nonStatus = withBirdTip(baseError, "https://x.com/user", { PATH: "" });
    expect(nonStatus.message).toBe(baseError.message);
  });
});
