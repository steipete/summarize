import { once } from "node:events";
import { createServer, type ServerResponse } from "node:http";
import { describe, expect, it } from "vitest";
import { transcribeWithAssemblyAi } from "../packages/core/src/transcription/whisper/assemblyai.js";
import { transcribeWithFal } from "../packages/core/src/transcription/whisper/fal.js";

async function serve(
  run: (url: string, closed: (path: string) => boolean) => Promise<void>,
  handle: (path: string, res: ServerResponse) => void,
) {
  const closed = new Set<string>();
  const server = createServer((req, res) => {
    req.resume();
    res.on("close", () => {
      if (!res.writableEnded) closed.add(req.url ?? "/");
    });
    handle(req.url ?? "/", res);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing test server address");
  try {
    await run(`http://127.0.0.1:${address.port}`, (path) =>
      [...closed].some((url) => url.startsWith(path)),
    );
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function json(res: ServerResponse, value: unknown) {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify(value));
}

describe("transcription deadlines over real HTTP", () => {
  it.each(["upload", "submit", "poll"])(
    "aborts an AssemblyAI %s response body and preserves the timeout",
    async (stage) => {
      await serve(
        async (baseUrl, closed) => {
          await expect(
            transcribeWithAssemblyAi(new Uint8Array([1]), "audio/mpeg", "synthetic-key", {
              baseUrl,
              timeoutMs: 100,
              pollIntervalMs: 1,
            }),
          ).rejects.toThrow("timed out");
          await new Promise((resolve) => setTimeout(resolve, 20));
          expect(closed(stage === "upload" ? "/upload" : "/transcript")).toBe(true);
        },
        (path, res) => {
          if (path === "/upload" && stage !== "upload")
            return json(res, { upload_url: "https://example.com/audio" });
          if (path === "/transcript" && stage === "poll")
            return json(res, { id: "synthetic", status: "queued" });
          res.writeHead(200, { "content-type": "application/json" });
          res.write("{");
        },
      );
    },
  );

  it("keeps AssemblyAI's post-submission processing allowance", async () => {
    await serve(
      async (baseUrl) => {
        await expect(
          transcribeWithAssemblyAi(new Uint8Array([1]), "audio/mpeg", "synthetic-key", {
            baseUrl,
            timeoutMs: 200,
            pollIntervalMs: 1,
          }),
        ).resolves.toBe("transcript");
      },
      (path, res) => {
        setTimeout(() => {
          if (path === "/upload") json(res, { upload_url: "https://example.com/audio" });
          else if (path === "/transcript") json(res, { id: "synthetic", status: "queued" });
          else json(res, { status: "completed", text: "transcript" });
        }, 90);
      },
    );
  });

  it.each(["initiate", "upload"])("cancels a stalled FAL %s request", async (stage) => {
    await serve(
      async (baseUrl, closed) => {
        const fetchImpl: typeof fetch = (input, init) => {
          const url = new URL(String(input));
          return fetch(`${baseUrl}${url.pathname}`, init);
        };
        await expect(
          transcribeWithFal(new Uint8Array([1]), "audio/mpeg", "synthetic-key", {
            fetchImpl,
            timeoutMs: 100,
          }),
        ).rejects.toThrow("FAL transcription timeout");
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(closed(stage === "upload" ? "/upload" : "/storage/upload/initiate")).toBe(true);
      },
      (path, res) => {
        if (path.includes("/initiate") && stage === "upload") {
          return json(res, {
            upload_url: "https://example.com/upload",
            file_url: "https://example.com/audio",
          });
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.write("{");
      },
    );
  });
});
