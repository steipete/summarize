import { join, resolve as resolvePath } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveCachePath } from "../src/cache.js";

describe("resolveCachePath", () => {
  it("uses HOME for default path", () => {
    const home = "/tmp/summarize-home";
    const resolved = resolveCachePath({ env: { HOME: home }, cachePath: null });
    expect(resolved).toBe(join(home, ".summarize", "cache.sqlite"));
  });

  it("expands relative and tilde paths", () => {
    const home = "/tmp/summarize-home";
    const relative = resolveCachePath({ env: { HOME: home }, cachePath: "cache.sqlite" });
    const tilde = resolveCachePath({ env: { HOME: home }, cachePath: "~/cache.sqlite" });
    expect(relative).toBe(resolvePath(join(home, "cache.sqlite")));
    expect(tilde).toBe(resolvePath(join(home, "cache.sqlite")));
  });

  it("keeps non-slash tilde prefixes as relative paths", () => {
    const home = "/tmp/summarize-home";
    const resolved = resolveCachePath({ env: { HOME: home }, cachePath: "~somepath" });
    expect(resolved).toBe(resolvePath(join(home, "~somepath")));
  });

  it("returns null when no home is available", () => {
    expect(resolveCachePath({ env: {}, cachePath: null })).toBeNull();
  });

  it("accepts absolute paths without HOME", () => {
    const absolute = "/tmp/summarize-cache.sqlite";
    expect(resolveCachePath({ env: {}, cachePath: absolute })).toBe(absolute);
  });
});
