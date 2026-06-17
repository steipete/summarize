import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { runCli } from "../src/run.js";

function collectStream() {
  let text = "";
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      text += chunk.toString();
      callback();
    },
  });
  return { stream, getText: () => text };
}

function makeExecutable(dir: string, name: string): string {
  const file = join(dir, name);
  writeFileSync(file, "#!/bin/sh\nexit 0\n");
  chmodSync(file, 0o755);
  return file;
}

describe("summarize status", () => {
  it("shows the effective model without missing-provider noise", async () => {
    const home = mkdtempSync(join(tmpdir(), "summarize-status-empty-"));
    const stdout = collectStream();
    const stderr = collectStream();

    await runCli(["status"], {
      env: { HOME: home, PATH: "" },
      fetch: vi.fn() as unknown as typeof fetch,
      stdout: stdout.stream,
      stderr: stderr.stream,
    });

    expect(stdout.getText()).toBe("Model: auto (default)\n");
    expect(stdout.getText()).not.toContain("missing");
    expect(stderr.getText()).toBe("");
  });

  it("lists configured presets, APIs, and available CLI providers only", async () => {
    const home = mkdtempSync(join(tmpdir(), "summarize-status-configured-"));
    const configDir = join(home, ".summarize");
    const binDir = join(home, "bin");
    mkdirSync(configDir, { recursive: true });
    mkdirSync(binDir, { recursive: true });
    const claudePath = makeExecutable(binDir, "claude");
    writeFileSync(
      join(configDir, "config.json"),
      JSON.stringify({
        model: "openai/gpt-5.5",
        models: {
          brief: { id: "openai/gpt-5-mini" },
          routed: {
            mode: "auto",
            rules: [{ candidates: ["openrouter/openai/gpt-5-mini"] }],
          },
        },
        env: { OPENAI_API_KEY: "secret-value" },
        cli: { enabled: ["claude"], claude: { model: "sonnet" } },
      }),
    );
    const stdout = collectStream();
    const stderr = collectStream();

    await runCli(["status", "--verbose"], {
      env: { HOME: home, PATH: binDir },
      fetch: vi.fn() as unknown as typeof fetch,
      stdout: stdout.stream,
      stderr: stderr.stream,
    });

    const out = stdout.getText();
    expect(out).toContain("Model: openai/gpt-5.5 (config)");
    expect(out).toContain(`Config: ${join(configDir, "config.json")}`);
    expect(out).toContain("brief: openai/gpt-5-mini");
    expect(out).toContain("routed: auto -> openrouter/openai/gpt-5-mini");
    expect(out).toContain("OpenAI API: configured");
    expect(out).toContain(`Claude CLI: available (model sonnet, ${claudePath})`);
    expect(out).not.toContain("Anthropic");
    expect(out).not.toContain("secret-value");
    expect(stderr.getText()).toBe("");
  });

  it("outputs positive-only structured JSON without secrets", async () => {
    const home = mkdtempSync(join(tmpdir(), "summarize-status-json-"));
    const configDir = join(home, ".summarize");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, "config.json"),
      JSON.stringify({ env: { ANTHROPIC_API_KEY: "top-secret" } }),
    );
    const stdout = collectStream();
    const stderr = collectStream();

    await runCli(["status", "--json"], {
      env: { HOME: home, PATH: "" },
      fetch: vi.fn() as unknown as typeof fetch,
      stdout: stdout.stream,
      stderr: stderr.stream,
    });

    const raw = stdout.getText();
    const report = JSON.parse(raw) as {
      providers: Array<{ id: string; state: string; source?: string }>;
    };
    expect(report.providers).toEqual([
      expect.objectContaining({
        id: "anthropic",
        state: "configured",
        source: "ANTHROPIC_API_KEY",
      }),
    ]);
    expect(raw).not.toContain("top-secret");
    expect(raw).not.toContain("openai");
    expect(stderr.getText()).toBe("");
  });

  it("reports shared runtime provider aliases and endpoints", async () => {
    const home = mkdtempSync(join(tmpdir(), "summarize-status-runtime-"));
    const stdout = collectStream();
    const stderr = collectStream();

    await runCli(["status", "--json"], {
      env: {
        HOME: home,
        PATH: "",
        XAI_API_KEY: "x-secret",
        XAI_BASE_URL: "https://xai.example/v1",
        EVOLINK_API_KEY: "evolink-secret",
        NGC_API_KEY: "nvidia-secret",
        GH_TOKEN: "github-secret",
      },
      fetch: vi.fn() as unknown as typeof fetch,
      stdout: stdout.stream,
      stderr: stderr.stream,
    });

    const report = JSON.parse(stdout.getText()) as {
      providers: Array<{ id: string; source?: string; endpoint?: string }>;
    };
    expect(report.providers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "xai",
          source: "XAI_API_KEY",
          endpoint: "xai.example",
        }),
        expect.objectContaining({
          id: "evolink",
          source: "EVOLINK_API_KEY",
          endpoint: "direct.evolink.ai",
        }),
        expect.objectContaining({
          id: "nvidia",
          source: "NGC_API_KEY",
          endpoint: "integrate.api.nvidia.com",
        }),
        expect.objectContaining({
          id: "github-models",
          source: "GH_TOKEN",
          endpoint: "models.github.ai",
        }),
      ]),
    );
    expect(stdout.getText()).not.toContain("secret");
    expect(stderr.getText()).toBe("");
  });

  it("discovers a usable Ollama server at the default endpoint when probed", async () => {
    const home = mkdtempSync(join(tmpdir(), "summarize-status-probe-"));
    const stdout = collectStream();
    const stderr = collectStream();
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("http://localhost:11434/v1/models");
      expect(init?.headers).toBeUndefined();
      return {
        ok: true,
        json: async () => ({ data: [{ id: "qwen3:14b" }] }),
      } as Response;
    }) as unknown as typeof fetch;

    await runCli(["status", "--probe", "--json"], {
      env: { HOME: home, PATH: "" },
      fetch: fetchImpl,
      stdout: stdout.stream,
      stderr: stderr.stream,
    });

    const report = JSON.parse(stdout.getText()) as {
      providers: Array<{ id: string; state: string; models?: string[] }>;
    };
    expect(report.providers).toEqual([
      expect.objectContaining({
        id: "ollama",
        state: "usable",
        models: ["ollama/qwen3:14b"],
      }),
    ]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(stderr.getText()).toBe("");
  });

  it("prints dedicated help", async () => {
    const stdout = collectStream();
    const stderr = collectStream();

    await runCli(["status", "--help"], {
      env: {},
      fetch: vi.fn() as unknown as typeof fetch,
      stdout: stdout.stream,
      stderr: stderr.stream,
    });

    expect(stdout.getText()).toContain("Usage: summarize status");
    expect(stdout.getText()).toContain("--probe");
    expect(stderr.getText()).toBe("");
  });
});
