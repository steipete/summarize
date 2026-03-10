import { describe, expect, it } from "vitest";
import { buildHealthPayload, corsHeaders, isTrustedOrigin } from "../src/daemon/server.js";
import { resolvePackageVersion } from "../src/version.js";

describe("daemon/server health payload", () => {
  it("includes daemon version and pid", () => {
    const payload = buildHealthPayload(import.meta.url);
    expect(payload.ok).toBe(true);
    expect(payload.pid).toBe(process.pid);
    expect(payload.version).toBe(resolvePackageVersion(import.meta.url));
  });
});

describe("daemon/server CORS allowlist", () => {
  it.each([
    "chrome-extension://abcdefghijklmnopabcdefghijklmnop",
    "moz-extension://12345678-1234-1234-1234-123456789abc",
    "safari-web-extension://com.example.summarize",
    "http://localhost:8787",
    "http://127.0.0.1:8787",
    "http://[::1]:8787",
  ])("allows trusted origin %s", (origin) => {
    expect(isTrustedOrigin(origin)).toBe(true);
    expect(corsHeaders(origin)["access-control-allow-origin"]).toBe(origin);
  });

  it.each([
    "https://attacker.example",
    "https://youtube.com.attacker.example",
    "not a url",
    "file:///tmp/test.html",
  ])("rejects untrusted origin %s", (origin) => {
    expect(isTrustedOrigin(origin)).toBe(false);
    expect(corsHeaders(origin)).toEqual({});
  });

  it("omits CORS headers when origin is missing", () => {
    expect(corsHeaders(null)).toEqual({});
  });

  // --- Additional edge-case coverage (follow-up to #108) ---

  it.each([
    "http://localhost",
    "https://localhost",
    "https://localhost:8787",
    "http://127.0.0.1",
    "https://127.0.0.1:8787",
    "http://[::1]",
    "http://localhost:3000",
  ])("allows localhost variant %s regardless of scheme or port", (origin) => {
    expect(isTrustedOrigin(origin)).toBe(true);
    expect(corsHeaders(origin)["access-control-allow-origin"]).toBe(origin);
  });

  it.each([
    "CHROME-EXTENSION://abcdef",
    "Chrome-Extension://abcdef",
    "MOZ-EXTENSION://abcdef",
    "Safari-Web-Extension://com.example.summarize",
  ])("allows case-insensitive extension protocol %s", (origin) => {
    expect(isTrustedOrigin(origin)).toBe(true);
  });

  it.each([
    "http://localhost.evil.com",
    "http://localhost.evil.com:8787",
    "http://127.0.0.2:8787",
    "http://0.0.0.0:8787",
    "null",
    "javascript:alert(1)",
    "data:text/html,<h1>test</h1>",
    "chrome-extension-evil://abc",
    "",
  ])("rejects bypass attempt %s", (origin) => {
    expect(isTrustedOrigin(origin)).toBe(false);
    expect(corsHeaders(origin)).toEqual({});
  });

  it("returns the full set of CORS headers for a trusted origin", () => {
    const headers = corsHeaders("http://localhost:8787");
    expect(headers).toEqual({
      "access-control-allow-origin": "http://localhost:8787",
      "access-control-allow-credentials": "true",
      "access-control-allow-headers": "authorization, content-type",
      "access-control-allow-methods": "GET,POST,OPTIONS",
      "access-control-allow-private-network": "true",
      "access-control-max-age": "600",
      vary: "Origin",
    });
  });
});
