import type http from "node:http";
import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { MAX_MAX_CHARS } from "../apps/chrome-extension/src/lib/settings.js";
import {
  parseSummarizeRequest,
  SUMMARIZE_REQUEST_BODY_MAX_BYTES,
} from "../src/daemon/server-summarize-request.js";

function createJsonRequest(body: unknown): http.IncomingMessage {
  const req = Readable.from([JSON.stringify(body)]) as http.IncomingMessage;
  req.headers = {};
  return req;
}

function createResponse(): http.ServerResponse {
  return {
    writeHead: vi.fn(),
    end: vi.fn(),
  } as unknown as http.ServerResponse;
}

const resolveToolPath = (binary: string) => (binary === "tesseract" ? "/usr/bin/tesseract" : null);

describe("parseSummarizeRequest slides settings", () => {
  it("accepts the largest extension page-text payload plus JSON overhead", async () => {
    const body = {
      url: "https://example.com/article",
      mode: "page",
      text: "x".repeat(MAX_MAX_CHARS),
      maxCharacters: MAX_MAX_CHARS,
    };
    const serializedBytes = Buffer.byteLength(JSON.stringify(body));

    expect(serializedBytes).toBeGreaterThan(2_000_000);
    expect(serializedBytes).toBeLessThanOrEqual(SUMMARIZE_REQUEST_BODY_MAX_BYTES);

    const parsed = await parseSummarizeRequest({
      req: createJsonRequest(body),
      res: createResponse(),
      cors: {},
      env: { HOME: "/home/alice" },
      resolveToolPath,
    });

    expect(parsed?.textContent).toHaveLength(MAX_MAX_CHARS);
    expect(parsed?.maxCharacters).toBe(MAX_MAX_CHARS);
  });

  it("keeps daemon-requested slide output under the user Summarize directory", async () => {
    for (const slidesDir of ["/tmp/attacker-slides", "../../attacker-slides", "nested/slides"]) {
      const parsed = await parseSummarizeRequest({
        req: createJsonRequest({
          url: "https://example.com/video.mp4",
          mode: "url",
          slides: true,
          slidesDir,
        }),
        res: createResponse(),
        cors: {},
        env: { HOME: "/home/alice" },
        resolveToolPath,
      });

      expect(parsed).not.toBeNull();
      expect(parsed?.slidesSettings?.outputDir).toBe("/home/alice/.summarize/slides");
    }
  });

  it("still honors non-path slide options from daemon requests", async () => {
    const parsed = await parseSummarizeRequest({
      req: createJsonRequest({
        url: "https://example.com/video.mp4",
        mode: "url",
        slides: true,
        slidesOcr: true,
        slidesMax: 3,
        slidesMinDuration: 4,
        slidesSceneThreshold: 0.5,
      }),
      res: createResponse(),
      cors: {},
      env: { HOME: "/home/alice" },
      resolveToolPath,
    });

    expect(parsed?.slidesSettings).toMatchObject({
      enabled: true,
      ocr: true,
      outputDir: "/home/alice/.summarize/slides",
      maxSlides: 3,
      minDurationSeconds: 4,
      sceneThreshold: 0.5,
    });
  });
});
