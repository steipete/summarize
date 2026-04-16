import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { runCli } from "../src/run.js";

const htmlResponse = (html: string, status = 200) =>
  new Response(html, {
    status,
    headers: { "Content-Type": "text/html" },
  });

function noopStream(): Writable {
  return new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
}

describe("--clear-cache", () => {
  it("clears the cache database and exits", async () => {
    const root = mkdtempSync(join(tmpdir(), "summarize-clear-cache-"));
    const summarizeDir = join(root, ".summarize");
    mkdirSync(summarizeDir, { recursive: true });
    const cachePath = join(summarizeDir, "cache.sqlite");
    writeFileSync(cachePath, "dummy", "utf8");

    await runCli(["--clear-cache"], {
      env: { HOME: root },
      fetch: globalThis.fetch,
      stdout: noopStream(),
      stderr: noopStream(),
    });

    expect(existsSync(cachePath)).toBe(false);
  });

  it("requires --clear-cache to be used alone", async () => {
    const root = mkdtempSync(join(tmpdir(), "summarize-clear-cache-"));
    await expect(
      runCli(["--clear-cache", "https://example.com"], {
        env: { HOME: root },
        fetch: globalThis.fetch,
        stdout: noopStream(),
        stderr: noopStream(),
      }),
    ).rejects.toThrow(/--clear-cache must be used alone/i);
  });

  it("does not create a cache db when --no-cache is set", async () => {
    const root = mkdtempSync(join(tmpdir(), "summarize-no-cache-"));
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.url;
      if (url === "https://example.com") {
        return htmlResponse("<!doctype html><html><body>Hi</body></html>");
      }
      throw new Error(`Unexpected fetch call: ${url}`);
    });

    await runCli(["--extract", "--json", "--no-cache", "https://example.com"], {
      env: { HOME: root },
      fetch: fetchMock as unknown as typeof fetch,
      stdout: noopStream(),
      stderr: noopStream(),
    });

    expect(existsSync(join(root, ".summarize", "cache.sqlite"))).toBe(false);
  });
});
