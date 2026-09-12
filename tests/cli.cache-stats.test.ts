import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createCacheStore } from "../src/cache.js";
import { runCli } from "../src/run.js";
import { discardStream as noopStream, captureStream as collectStream } from "./helpers/streams.js";

describe("--cache-stats", () => {
  it("prints cache entry counts", async () => {
    const root = mkdtempSync(join(tmpdir(), "summarize-cache-stats-"));
    const path = join(root, ".summarize", "cache.sqlite");
    const store = await createCacheStore({ path, maxBytes: 1024 * 1024 });

    store.setText("extract", "e1", "value", null);
    store.setText("summary", "s1", "value", null);
    await store.transcriptCache.set({
      url: "https://example.com",
      service: "youtube",
      resourceKey: "abc",
      ttlMs: 1000,
      content: "hi",
      source: "youtubei",
      metadata: null,
    });

    store.close();

    const stdout = collectStream();
    await runCli(["--cache-stats"], {
      env: { HOME: root },
      fetch: globalThis.fetch.bind(globalThis),
      stdout: stdout.stream,
      stderr: noopStream(),
    });

    const output = stdout.getText();
    expect(output).toContain("Entries: total=3");
    expect(output).toContain("extract=1");
    expect(output).toContain("summary=1");
    expect(output).toContain("transcript=1");
  });
});
