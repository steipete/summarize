import { describe, expect, it, vi } from "vitest";
import { runCli } from "../src/run.js";
import { captureStream as collectStream } from "./helpers/streams.js";

const htmlResponse = (html: string, status = 200) =>
  new Response(html, {
    status,
    headers: { "Content-Type": "text/html" },
  });

describe("--model auto no-model JSON", () => {
  it("returns extracted content as JSON when no model keys are configured", async () => {
    const fetchMock = vi.fn(async () =>
      htmlResponse(
        "<!doctype html><html><body><article><p>Hello world</p></article></body></html>",
      ),
    );

    const stdout = collectStream();
    const stderr = collectStream();

    await runCli(["--model", "auto", "--json", "--metrics", "off", "https://example.com"], {
      env: {},
      fetch: fetchMock as unknown as typeof fetch,
      stdout: stdout.stream,
      stderr: stderr.stream,
    });

    expect(stderr.getText().trim()).toBe("");

    const payload = JSON.parse(stdout.getText()) as {
      llm: unknown;
      summary?: string;
      input?: { kind?: string; url?: string };
    };
    expect(payload.input?.kind).toBe("url");
    expect(payload.input?.url).toBe("https://example.com");
    expect(payload.llm).toBe(null);
    expect(payload.summary).toMatch(/hello world/i);
  });
});
