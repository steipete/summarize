import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import {
  applyWidthOverride,
  handleVersionFlag,
  prepareRunEnvironment,
  resolvePromptOverride,
} from "../src/run/runner-setup.js";

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

describe("runner setup", () => {
  it("normalizes bare diarize URLs and honors --no-color", () => {
    const { normalizedArgv, envForRun } = prepareRunEnvironment(
      ["--", "--diarize", "https://www.youtube.com/watch?v=abcdefghijk", "--no-color"],
      { HOME: mkdtempSync(join(tmpdir(), "summarize-runner-setup-")) },
    );

    expect(normalizedArgv).toEqual([
      "--diarize=auto",
      "https://www.youtube.com/watch?v=abcdefghijk",
      "--no-color",
    ]);
    expect(envForRun.NO_COLOR).toBe("1");
    expect(envForRun.FORCE_COLOR).toBe("0");
  });

  it("leaves color env untouched when --no-color is absent", () => {
    const { normalizedArgv, envForRun } = prepareRunEnvironment(
      ["--diarize", "openai", "https://www.youtube.com/watch?v=abcdefghijk"],
      { HOME: mkdtempSync(join(tmpdir(), "summarize-runner-setup-")), FORCE_COLOR: "1" },
    );

    expect(normalizedArgv).toEqual([
      "--diarize",
      "openai",
      "https://www.youtube.com/watch?v=abcdefghijk",
    ]);
    expect(envForRun.FORCE_COLOR).toBe("1");
    expect(envForRun.NO_COLOR).toBeUndefined();
  });

  it("writes a version line only when requested", () => {
    const quietOut = collectStream();
    expect(
      handleVersionFlag({
        versionRequested: false,
        stdout: quietOut.stream,
      }),
    ).toBe(false);
    expect(quietOut.getText()).toBe("");

    const versionOut = collectStream();
    expect(
      handleVersionFlag({
        versionRequested: true,
        stdout: versionOut.stream,
        importMetaUrl: import.meta.url,
      }),
    ).toBe(true);
    expect(versionOut.getText()).toMatch(/^\d+\.\d+\.\d+(?: \([^)]+\))?\n$/);
  });

  it("applies valid width overrides and rejects invalid widths", () => {
    const env: Record<string, string | undefined> = {};
    applyWidthOverride({ width: "120.9", env });
    expect(env.COLUMNS).toBe("120");

    expect(() => applyWidthOverride({ width: "19", env })).toThrow(
      "--width must be a number >= 20.",
    );
    expect(() => applyWidthOverride({ width: "nope", env })).toThrow(
      "--width must be a number >= 20.",
    );
  });

  it("resolves prompt overrides from trimmed inline and file inputs", async () => {
    await expect(
      resolvePromptOverride({
        prompt: " inline prompt ",
        promptFile: null,
      }),
    ).resolves.toBe("inline prompt");

    const root = mkdtempSync(join(tmpdir(), "summarize-runner-setup-"));
    const promptFile = join(root, "prompt.txt");
    writeFileSync(promptFile, "  from file  \n", "utf8");

    await expect(
      resolvePromptOverride({
        prompt: null,
        promptFile,
      }),
    ).resolves.toBe("from file");

    await expect(
      resolvePromptOverride({
        prompt: "inline",
        promptFile,
      }),
    ).rejects.toThrow("Use either --prompt or --prompt-file (not both).");
  });
});
