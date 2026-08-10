import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const extensionRequire = createRequire(resolve("apps/chrome-extension/package.json"));
const webExtRequire = createRequire(extensionRequire.resolve("web-ext"));

describe("patched image-size dependency", () => {
  it("rejects zero-length boxes and ICNS entries without looping", () => {
    const probe = String.raw`
      const { imageSize } = require(process.argv[1]);
      const { findBox } = require(process.argv[2]);

      const zeroLengthBox = Uint8Array.from([
        0x00, 0x00, 0x00, 0x00,
        0x69, 0x73, 0x70, 0x65,
      ]);
      if (findBox(zeroLengthBox, "ispe", 0) !== undefined) {
        throw new Error("zero-length ISO box was accepted");
      }

      const zeroLengthIcns = Uint8Array.from([
        0x69, 0x63, 0x6e, 0x73,
        0x00, 0x00, 0x00, 0x10,
        0x69, 0x73, 0x33, 0x32,
        0x00, 0x00, 0x00, 0x00,
      ]);
      try {
        imageSize(zeroLengthIcns);
        throw new Error("zero-length ICNS entry was accepted");
      } catch (error) {
        if (!/Invalid ICNS entry length/.test(String(error))) throw error;
      }
    `;

    expect(() =>
      execFileSync(
        process.execPath,
        [
          "--eval",
          probe,
          webExtRequire.resolve("image-size"),
          webExtRequire.resolve("image-size/types/utils"),
        ],
        { stdio: "pipe", timeout: 2_000 },
      ),
    ).not.toThrow();
  });
});
