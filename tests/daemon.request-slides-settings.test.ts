import type http from "node:http";
import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { parseSummarizeRequest } from "../src/daemon/server-summarize-request.js";

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
