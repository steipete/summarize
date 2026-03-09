import { describe, expect, it } from "vitest";
import {
  DEFAULT_DENIED_HOSTS,
  deniedSiteError,
  isDeniedHost,
} from "../apps/chrome-extension/src/lib/denylist.js";

describe("chrome/denylist", () => {
  describe("DEFAULT_DENIED_HOSTS", () => {
    it("contains expected entries", () => {
      expect(DEFAULT_DENIED_HOSTS).toContain("facebook.com");
      expect(DEFAULT_DENIED_HOSTS).toContain("instagram.com");
      expect(DEFAULT_DENIED_HOSTS).toContain("messenger.com");
      expect(DEFAULT_DENIED_HOSTS).toContain("accounts.google.com");
    });
  });

  describe("isDeniedHost", () => {
    it("matches exact hostname", () => {
      expect(isDeniedHost("facebook.com")).toBe(true);
      expect(isDeniedHost("instagram.com")).toBe(true);
      expect(isDeniedHost("messenger.com")).toBe(true);
    });

    it("matches subdomains via suffix", () => {
      expect(isDeniedHost("www.facebook.com")).toBe(true);
      expect(isDeniedHost("m.facebook.com")).toBe(true);
      expect(isDeniedHost("static.instagram.com")).toBe(true);
      expect(isDeniedHost("accounts.google.com")).toBe(true);
    });

    it("does not match unrelated domains", () => {
      expect(isDeniedHost("github.com")).toBe(false);
      expect(isDeniedHost("google.com")).toBe(false);
      expect(isDeniedHost("example.com")).toBe(false);
    });

    it("does not match lookalikes that merely contain the denied domain name", () => {
      expect(isDeniedHost("evilfacebook.com")).toBe(false);
      expect(isDeniedHost("notfacebook.com")).toBe(false);
      expect(isDeniedHost("facebook.com.evil.com")).toBe(false);
    });

    it("is case-insensitive", () => {
      expect(isDeniedHost("Facebook.com")).toBe(true);
      expect(isDeniedHost("INSTAGRAM.COM")).toBe(true);
      expect(isDeniedHost("WWW.FACEBOOK.COM")).toBe(true);
    });

    it("respects extra denylist entries", () => {
      expect(isDeniedHost("example.com", ["example.com"])).toBe(true);
      expect(isDeniedHost("sub.example.com", ["example.com"])).toBe(true);
      expect(isDeniedHost("other.com", ["example.com"])).toBe(false);
    });

    it("does not deny empty hostname", () => {
      expect(isDeniedHost("")).toBe(false);
    });
  });

  describe("deniedSiteError", () => {
    it("includes the hostname in the message", () => {
      expect(deniedSiteError("facebook.com")).toContain("facebook.com");
      expect(deniedSiteError("www.instagram.com")).toContain("www.instagram.com");
    });

    it("mentions site restrictions", () => {
      expect(deniedSiteError("facebook.com")).toMatch(/site restriction/i);
    });
  });
});
