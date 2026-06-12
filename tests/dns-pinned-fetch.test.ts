import { createServer, type Server } from "node:http";
import {
  attachDnsPinnedAddresses,
  fetchWithDnsPinnedAddresses,
} from "@steipete/summarize-core/content";
import { afterEach, describe, expect, it } from "vitest";

const servers: Server[] = [];

async function listen(server: Server): Promise<number> {
  return await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Failed to bind test server"));
        return;
      }
      servers.push(server);
      resolve(address.port);
    });
  });
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        }),
    ),
  );
});

describe("DNS-pinned fetch transport", () => {
  it("fetches HTTP URLs using the validated address list", async () => {
    const server = createServer((req, res) => {
      expect(req.headers.host).toMatch(/^pinned\.example:/);
      res.writeHead(200, { "content-type": "text/plain" });
      res.end(`ok ${req.url ?? ""}`);
    });
    const port = await listen(server);

    const response = await fetchWithDnsPinnedAddresses(
      `http://pinned.example:${port}/transcript.txt`,
      attachDnsPinnedAddresses({ headers: { accept: "text/plain" }, redirect: "manual" }, [
        { address: "127.0.0.1", family: 4 },
      ]),
    );

    expect(response.url).toBe(`http://pinned.example:${port}/transcript.txt`);
    expect(response.headers.get("content-type")).toBe("text/plain");
    await expect(response.text()).resolves.toBe("ok /transcript.txt");
  });

  it("rejects calls without attached validated addresses", async () => {
    await expect(fetchWithDnsPinnedAddresses("http://pinned.example/")).rejects.toThrow(
      /missing validated addresses/i,
    );
  });

  it("rejects body-bearing pinned requests instead of dropping the body", async () => {
    await expect(
      fetchWithDnsPinnedAddresses(
        "http://pinned.example/",
        attachDnsPinnedAddresses({ body: "payload", method: "POST" }, [
          { address: "127.0.0.1", family: 4 },
        ]),
      ),
    ).rejects.toThrow(/does not support request bodies/i);
  });
});
