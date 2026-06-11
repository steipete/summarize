import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { fetchWithDnsPinnedAddresses as fetchWithCorePinnedDns } from "../packages/core/src/content/dns-pinned-fetch.js";
import { attachDnsPinnedAddresses as attachCoreDnsPinnedAddresses } from "../packages/core/src/content/index.js";
import { fetchWithDnsPinnedAddresses as fetchWithRootPinnedDns } from "../src/shared/dns-pinned-fetch.js";
import { attachDnsPinnedAddresses as attachRootDnsPinnedAddresses } from "../src/shared/fetch-capabilities.js";

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
  for (const [label, fetchImpl, attachAddresses] of [
    ["root", fetchWithRootPinnedDns, attachRootDnsPinnedAddresses],
    ["core", fetchWithCorePinnedDns, attachCoreDnsPinnedAddresses],
  ] as const) {
    it(`fetches ${label} HTTP URLs using the validated address list`, async () => {
      const server = createServer((req, res) => {
        expect(req.headers.host).toMatch(/^pinned\.example:/);
        res.writeHead(200, { "content-type": "text/plain" });
        res.end(`ok ${req.url ?? ""}`);
      });
      const port = await listen(server);

      const response = await fetchImpl(
        `http://pinned.example:${port}/transcript.txt`,
        attachAddresses({ headers: { accept: "text/plain" }, redirect: "manual" }, [
          { address: "127.0.0.1", family: 4 },
        ]),
      );

      expect(response.url).toBe(`http://pinned.example:${port}/transcript.txt`);
      expect(response.headers.get("content-type")).toBe("text/plain");
      await expect(response.text()).resolves.toBe("ok /transcript.txt");
    });
  }

  it("rejects calls without attached validated addresses", async () => {
    await expect(fetchWithRootPinnedDns("http://pinned.example/")).rejects.toThrow(
      /missing validated addresses/i,
    );
  });

  it("rejects body-bearing pinned requests instead of dropping the body", async () => {
    await expect(
      fetchWithRootPinnedDns(
        "http://pinned.example/",
        attachRootDnsPinnedAddresses({ body: "payload", method: "POST" }, [
          { address: "127.0.0.1", family: 4 },
        ]),
      ),
    ).rejects.toThrow(/does not support request bodies/i);
  });
});
