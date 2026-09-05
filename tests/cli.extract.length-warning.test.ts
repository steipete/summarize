import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { runCli } from "../src/run.js";
import { captureStream as collectStream } from "./helpers/streams.js";

const htmlResponse = (html: string, status = 200) =>
  new Response(html, {
    status,
    headers: { "Content-Type": "text/html" },
  });

describe("--extract warnings", () => {
  it("warns when --length is explicitly set with --extract (TTY stderr, non-JSON)", async () => {
    const root = mkdtempSync(join(tmpdir(), "summarize-extract-length-warning-"));
    const html =
      "<!doctype html><html><head><title>Hello</title></head>" +
      "<body><article><p>Hi</p></article></body></html>";

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.url;
      if (url === "https://example.com") return htmlResponse(html);
      throw new Error(`Unexpected fetch call: ${url}`);
    });

    const stdout = collectStream();
    const stderr = collectStream();
    (stderr.stream as unknown as { isTTY?: boolean }).isTTY = true;

    await runCli(["--extract", "--timeout", "2s", "--length", "short", "https://example.com"], {
      env: { HOME: root },
      fetch: fetchMock as unknown as typeof fetch,
      stdout: stdout.stream,
      stderr: stderr.stream,
    });

    expect(stderr.getText()).toContain("--length is ignored with --extract");
  });

  it("does not warn when --length is not explicitly set (default)", async () => {
    const root = mkdtempSync(join(tmpdir(), "summarize-extract-length-no-warning-"));
    const html =
      "<!doctype html><html><head><title>Hello</title></head>" +
      "<body><article><p>Hi</p></article></body></html>";

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.url;
      if (url === "https://example.com") return htmlResponse(html);
      throw new Error(`Unexpected fetch call: ${url}`);
    });

    const stdout = collectStream();
    const stderr = collectStream();
    (stderr.stream as unknown as { isTTY?: boolean }).isTTY = true;

    await runCli(["--extract", "--timeout", "2s", "https://example.com"], {
      env: { HOME: root },
      fetch: fetchMock as unknown as typeof fetch,
      stdout: stdout.stream,
      stderr: stderr.stream,
    });

    expect(stderr.getText()).not.toContain("--length is ignored with --extract");
  });

  it("does not warn in --json mode", async () => {
    const root = mkdtempSync(join(tmpdir(), "summarize-extract-length-no-warning-json-"));
    const html =
      "<!doctype html><html><head><title>Hello</title></head>" +
      "<body><article><p>Hi</p></article></body></html>";

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.url;
      if (url === "https://example.com") return htmlResponse(html);
      throw new Error(`Unexpected fetch call: ${url}`);
    });

    const stdout = collectStream();
    const stderr = collectStream();
    (stderr.stream as unknown as { isTTY?: boolean }).isTTY = true;

    await runCli(
      [
        "--extract",
        "--json",
        "--metrics",
        "off",
        "--timeout",
        "2s",
        "--length",
        "short",
        "https://example.com",
      ],
      {
        env: { HOME: root },
        fetch: fetchMock as unknown as typeof fetch,
        stdout: stdout.stream,
        stderr: stderr.stream,
      },
    );

    expect(stderr.getText()).not.toContain("--length is ignored with --extract");
  });
});
