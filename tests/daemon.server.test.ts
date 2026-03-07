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
});
