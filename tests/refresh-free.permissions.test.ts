import { mkdirSync, mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { refreshFree } from "../src/refresh-free.js";

const mocks = vi.hoisted(() => ({
  generateTextWithModelId: vi.fn(async () => ({
    text: "OK",
    model: "openrouter/test/free:free",
    usage: null,
    raw: null,
  })),
}));

vi.mock("../src/llm/generate-text.js", () => ({
  generateTextWithModelId: mocks.generateTextWithModelId,
}));

function sink() {
  return new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
}

describe("refresh-free config file permissions proof", () => {
  afterEach(() => vi.restoreAllMocks());

  it("keeps refresh-free config rewrites owner-only", async () => {
    const oldUmask = process.umask(0o022);
    try {
      const home = mkdtempSync(join(tmpdir(), "summarize-refresh-free-perms-"));
      const configDir = join(home, ".summarize");
      const configPath = join(configDir, "config.json");
      mkdirSync(configDir, { recursive: true, mode: 0o700 });
      writeFileSync(
        configPath,
        JSON.stringify({ env: { OPENAI_API_KEY: "sk-secret" }, models: {} }, null, 2),
        { encoding: "utf8", mode: 0o600 },
      );
      expect(statSync(configPath).mode & 0o777).toBe(0o600);

      const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === "https://openrouter.ai/api/v1/models") {
          return new Response(
            JSON.stringify({
              data: [
                {
                  id: "test/free:free",
                  name: "Test Free 70B",
                  context_length: 128000,
                  top_provider: { max_completion_tokens: 4096 },
                  supported_parameters: ["temperature"],
                  architecture: { modality: "text->text" },
                  created: Math.floor(Date.now() / 1000),
                },
              ],
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        throw new Error(`unexpected fetch: ${url}`);
      }) as unknown as typeof fetch;

      await refreshFree({
        env: { HOME: home, OPENROUTER_API_KEY: "or-secret" },
        fetchImpl,
        stdout: sink(),
        stderr: sink(),
        options: { runs: 0, smart: 0, maxCandidates: 1, timeoutMs: 1, minParamB: 0 },
      });

      expect(statSync(configPath).mode & 0o777).toBe(0o600);
      expect(statSync(configDir).mode & 0o777).toBe(0o700);
    } finally {
      process.umask(oldUmask);
    }
  });
});
