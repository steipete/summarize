import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { runCli } from "../src/run.js";
import { captureStream as collectStream } from "./helpers/streams.js";

vi.mock("../src/llm/generate-text.js", () => ({
  generateTextWithModelId: vi.fn(async () => ({ text: "OK" })),
  streamTextWithModelId: vi.fn(async () => {
    throw new Error("unexpected stream call");
  }),
}));

describe("refresh-free", () => {
  it("writes models.free and shows total runs (1 + runs)", async () => {
    const root = mkdtempSync(join(tmpdir(), "summarize-refresh-free-"));
    mkdirSync(join(root, ".summarize"), { recursive: true });

    const stdout = collectStream();
    const stderr = collectStream();

    const created = Math.floor(Date.now() / 1000);
    const fetchMock = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          data: [
            {
              id: "google/gemini-2.0-flash-exp:free",
              name: "Gemini",
              context_length: 1234,
              created,
            },
            { id: "google/gemma-3-27b-it:free", name: "Gemma 27B", context_length: 5678, created },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    await runCli(["refresh-free", "--min-params", "0b"], {
      env: { HOME: root, OPENROUTER_API_KEY: "test" },
      fetch: fetchMock as unknown as typeof fetch,
      stdout: stdout.stream,
      stderr: stderr.stream,
    });

    expect(stderr.getText()).toMatch(/Refresh Free: found 2 :free models; testing \(runs=3/i);
    const configPath = join(root, ".summarize", "config.json");
    const config = JSON.parse(readFileSync(configPath, "utf8")) as {
      models?: { free?: { rules?: Array<{ candidates?: string[] }> } };
    };
    expect(config.models?.free?.rules?.[0]?.candidates?.length).toBeGreaterThan(0);
    expect(stdout.getText()).toMatch(/Wrote .*config\.json/i);
  });

  it("accepts --runs 0 (no refine pass)", async () => {
    const root = mkdtempSync(join(tmpdir(), "summarize-refresh-free-"));
    mkdirSync(join(root, ".summarize"), { recursive: true });

    const stdout = collectStream();
    const stderr = collectStream();

    const created = Math.floor(Date.now() / 1000);
    const fetchMock = vi.fn(async () => {
      return new Response(
        JSON.stringify({ data: [{ id: "google/gemma-3-27b-it:free", created }] }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    });

    await runCli(["refresh-free", "--runs", "0", "--min-params", "0b"], {
      env: { HOME: root, OPENROUTER_API_KEY: "test" },
      fetch: fetchMock as unknown as typeof fetch,
      stdout: stdout.stream,
      stderr: stderr.stream,
    });

    expect(stderr.getText()).toMatch(/testing \(runs=1/i);
    expect(stderr.getText()).not.toMatch(/refining .*extra runs/i);
  });

  it("backs off on rateLimitMin and retries once", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2025-01-01T00:00:00Z"));
      const { generateTextWithModelId } = await import("../src/llm/generate-text.js");
      const mock = generateTextWithModelId as unknown as ReturnType<typeof vi.fn>;

      let calls = 0;
      mock.mockImplementation(() => {
        calls += 1;
        if (calls === 1) {
          throw new Error("Rate limit exceeded: free-models-per-min.");
        }
        return { text: "OK" };
      });

      const root = mkdtempSync(join(tmpdir(), "summarize-refresh-free-"));
      mkdirSync(join(root, ".summarize"), { recursive: true });

      const stdout = collectStream();
      const stderr = collectStream();

      const created = Math.floor(Date.now() / 1000);
      const fetchMock = vi.fn(async () => {
        return new Response(
          JSON.stringify({ data: [{ id: "google/gemma-3-27b-it:free", created }] }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      });

      const promise = runCli(["refresh-free", "--runs", "0", "--min-params", "0b", "--verbose"], {
        env: { HOME: root, OPENROUTER_API_KEY: "test" },
        fetch: fetchMock as unknown as typeof fetch,
        stdout: stdout.stream,
        stderr: stderr.stream,
      });

      await vi.advanceTimersByTimeAsync(70_000);
      await promise;

      expect(calls).toBe(2);
      expect(stderr.getText()).toMatch(/rate limit hit; sleeping/i);
      expect(stdout.getText()).toMatch(/Wrote .*config\.json/i);
    } finally {
      vi.useRealTimers();
    }
  });

  it("filters models below default min params and prints skip list in --verbose", async () => {
    const root = mkdtempSync(join(tmpdir(), "summarize-refresh-free-"));
    mkdirSync(join(root, ".summarize"), { recursive: true });

    const stdout = collectStream();
    const stderr = collectStream();

    const created = Math.floor(Date.now() / 1000);
    const fetchMock = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          data: [
            { id: "acme/tiny-13b:free", name: "Tiny 13B", context_length: 1000, created },
            {
              id: "acme/big-27b:free",
              name: "Big 27B",
              context_length: 8000,
              created,
              top_provider: { max_completion_tokens: 2048 },
              supported_parameters: ["temperature"],
              architecture: { modality: "text" },
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    await runCli(["refresh-free", "--runs", "0", "--verbose"], {
      env: { HOME: root, OPENROUTER_API_KEY: "test" },
      fetch: fetchMock as unknown as typeof fetch,
      stdout: stdout.stream,
      stderr: stderr.stream,
    });

    expect(stderr.getText()).toMatch(/filtered 1\/2 small models \(<27B\)/i);
    expect(stderr.getText()).toMatch(/skip acme\/tiny-13b:free/i);
    expect(stdout.getText()).toMatch(/Wrote .*config\.json/i);
    const configPath = join(root, ".summarize", "config.json");
    const config = JSON.parse(readFileSync(configPath, "utf8")) as {
      models?: { free?: { rules?: Array<{ candidates?: string[] }> } };
    };
    const candidates = config.models?.free?.rules?.[0]?.candidates ?? [];
    expect(candidates).toEqual(["openrouter/acme/big-27b:free"]);
  });

  it("caps selection to 10 candidates", async () => {
    const root = mkdtempSync(join(tmpdir(), "summarize-refresh-free-"));
    mkdirSync(join(root, ".summarize"), { recursive: true });

    const stdout = collectStream();
    const stderr = collectStream();

    const created = Math.floor(Date.now() / 1000);
    const models = Array.from({ length: 15 }, (_v, i) => ({
      id: `acme/model-${i + 1}-27b:free`,
      name: `Model ${i + 1} 27B`,
      context_length: 8000 + i,
      created,
      top_provider: { max_completion_tokens: 2048 },
      supported_parameters: ["temperature"],
    }));

    const fetchMock = vi.fn(async () => {
      return new Response(JSON.stringify({ data: models }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    await runCli(["refresh-free", "--runs", "0", "--min-params", "27b"], {
      env: { HOME: root, OPENROUTER_API_KEY: "test" },
      fetch: fetchMock as unknown as typeof fetch,
      stdout: stdout.stream,
      stderr: stderr.stream,
    });

    expect(stderr.getText()).toMatch(/selected 10 candidates/i);
    const configPath = join(root, ".summarize", "config.json");
    const config = JSON.parse(readFileSync(configPath, "utf8")) as {
      models?: { free?: { rules?: Array<{ candidates?: string[] }> } };
    };
    const candidates = config.models?.free?.rules?.[0]?.candidates ?? [];
    expect(candidates).toHaveLength(10);
  });

  it("filters by max age days (default 180) and can be disabled with --max-age-days 0", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2025-01-01T00:00:00Z"));
      const root = mkdtempSync(join(tmpdir(), "summarize-refresh-free-"));
      mkdirSync(join(root, ".summarize"), { recursive: true });

      const stdout = collectStream();
      const stderr = collectStream();

      const nowSec = Math.floor(Date.now() / 1000);
      const within180d = nowSec - 10 * 24 * 60 * 60;
      const olderThan180d = nowSec - 200 * 24 * 60 * 60;

      const fetchMock = vi.fn(async () => {
        return new Response(
          JSON.stringify({
            data: [
              { id: "acme/new-27b:free", name: "New 27B", created: within180d },
              { id: "acme/old-70b:free", name: "Old 70B", created: olderThan180d },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      });

      await runCli(["refresh-free", "--runs", "0", "--min-params", "0b"], {
        env: { HOME: root, OPENROUTER_API_KEY: "test" },
        fetch: fetchMock as unknown as typeof fetch,
        stdout: stdout.stream,
        stderr: stderr.stream,
      });

      expect(stderr.getText()).toMatch(/filtered 1\/2 old models \(>180d\)/i);
      const configPath = join(root, ".summarize", "config.json");
      const config = JSON.parse(readFileSync(configPath, "utf8")) as {
        models?: { free?: { rules?: Array<{ candidates?: string[] }> } };
      };
      expect(config.models?.free?.rules?.[0]?.candidates).toEqual(["openrouter/acme/new-27b:free"]);

      const stdout2 = collectStream();
      const stderr2 = collectStream();
      await runCli(["refresh-free", "--runs", "0", "--min-params", "0b", "--max-age-days", "0"], {
        env: { HOME: root, OPENROUTER_API_KEY: "test" },
        fetch: fetchMock as unknown as typeof fetch,
        stdout: stdout2.stream,
        stderr: stderr2.stream,
      });
      expect(stderr2.getText()).not.toMatch(/old models/i);
      const config2 = JSON.parse(readFileSync(configPath, "utf8")) as {
        models?: { free?: { rules?: Array<{ candidates?: string[] }> } };
      };
      expect((config2.models?.free?.rules?.[0]?.candidates ?? []).length).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("sets config model=free with --set-default", async () => {
    const root = mkdtempSync(join(tmpdir(), "summarize-refresh-free-"));
    mkdirSync(join(root, ".summarize"), { recursive: true });

    const configPath = join(root, ".summarize", "config.json");
    writeFileSync(
      configPath,
      JSON.stringify({ model: "auto", models: { keep: { id: "openai/gpt-5.2" } } }, null, 2),
      "utf8",
    );

    const stdout = collectStream();
    const stderr = collectStream();

    const created = Math.floor(Date.now() / 1000);
    const fetchMock = vi.fn(async () => {
      return new Response(JSON.stringify({ data: [{ id: "acme/big-27b:free", created }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    await runCli(["refresh-free", "--runs", "0", "--min-params", "0b", "--set-default"], {
      env: { HOME: root, OPENROUTER_API_KEY: "test" },
      fetch: fetchMock as unknown as typeof fetch,
      stdout: stdout.stream,
      stderr: stderr.stream,
    });

    const config = JSON.parse(readFileSync(configPath, "utf8")) as {
      model?: string;
      models?: Record<string, unknown>;
    };
    expect(config.model).toBe("free");
    expect(config.models?.keep).toBeDefined();
    expect(config.models?.free).toBeDefined();
  });

  it("prints metadata (params, ctx, out, modality) in Selected section", async () => {
    const root = mkdtempSync(join(tmpdir(), "summarize-refresh-free-"));
    mkdirSync(join(root, ".summarize"), { recursive: true });

    const stdout = collectStream();
    const stderr = collectStream();

    const created = Math.floor(Date.now() / 1000);
    const fetchMock = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          data: [
            {
              id: "acme/big-27b:free",
              name: "Big 27B",
              context_length: 12345,
              created,
              top_provider: { max_completion_tokens: 2345 },
              supported_parameters: ["temperature", "max_tokens"],
              architecture: { modality: "text" },
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    await runCli(["refresh-free", "--runs", "0", "--min-params", "0b"], {
      env: { HOME: root, OPENROUTER_API_KEY: "test" },
      fetch: fetchMock as unknown as typeof fetch,
      stdout: stdout.stream,
      stderr: stderr.stream,
    });

    expect(stdout.getText()).toMatch(/Wrote .*config\.json/i);
    expect(stderr.getText()).toMatch(/Selected.*Δ latency/i);
    expect(stderr.getText()).toMatch(/~27B/i);
    expect(stderr.getText()).toMatch(/ctx=12k/i);
    expect(stderr.getText()).toMatch(/out=2k/i);
    expect(stderr.getText()).not.toMatch(/modality=/i);
    expect(stderr.getText()).toMatch(/\btext\b/i);
  });
});
