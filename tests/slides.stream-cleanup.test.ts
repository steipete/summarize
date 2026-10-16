import type http from "node:http";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ stream: vi.fn() }));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    createReadStream: mocks.stream,
    promises: {
      ...actual.promises,
      stat: vi.fn(async () => ({ size: 100 })),
    },
  };
});

import { handleSessionRoutes } from "../src/daemon/server-session-routes.js";
import { createSession } from "../src/daemon/server-session.js";

describe("slide image response cleanup", () => {
  it.each([false, true])(
    "closes the source when the client disconnects (already closed: %s)",
    async (alreadyClosed) => {
      const stream = new PassThrough();
      mocks.stream.mockReturnValue(stream);
      const res = Object.assign(new PassThrough(), { writeHead: vi.fn() });
      if (alreadyClosed) {
        res.destroy();
        await new Promise((resolve) => setImmediate(resolve));
      }
      const session = createSession(() => "slide-stream");
      session.slides = { slides: [{ index: 1, imagePath: "/synthetic/slide.png" }] } as NonNullable<
        typeof session.slides
      >;
      try {
        await handleSessionRoutes({
          req: { method: "GET" } as http.IncomingMessage,
          res: res as unknown as http.ServerResponse,
          pathname: "/v1/summarize/slide-stream/slides/1",
          cors: {},
          env: {},
          port: 8787,
          sessions: new Map([[session.id, session]]),
          refreshSessions: new Map(),
        });
        res.emit("close");
        expect(stream.destroyed).toBe(true);
      } finally {
        stream.destroy();
        res.destroy();
      }
    },
  );
});
