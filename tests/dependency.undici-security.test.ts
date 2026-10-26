import { createHash } from "node:crypto";
import { fetch } from "undici";
import { describe, expect, it } from "vitest";

describe("Undici subresource integrity", () => {
  const url = "data:text/plain,hello";
  const digest = createHash("sha256").update("hello").digest("base64");
  const wrongDigest = Buffer.alloc(32).toString("base64");

  it.each(["sha256", "SHA256", "sHa256"])("checks %s integrity tokens", async (algorithm) => {
    await expect(fetch(url, { integrity: `${algorithm}-${wrongDigest}` })).rejects.toThrow();
    const response = await fetch(url, { integrity: `${algorithm}-${digest}` });
    await expect(response.text()).resolves.toBe("hello");
  });
});
