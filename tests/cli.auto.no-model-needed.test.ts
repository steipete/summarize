import { mkdtempSync, writeFileSync } from "node:fs";
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

const mocks = vi.hoisted(() => ({
  streamSimple: vi.fn(() => {
    throw new Error("should not be called");
  }),
  completeSimple: vi.fn(() => {
    throw new Error("should not be called");
  }),
  getModel: vi.fn(() => {
    throw new Error("no model");
  }),
}));

vi.mock("@earendil-works/pi-ai/compat", () => ({
  streamSimple: mocks.streamSimple,
  completeSimple: mocks.completeSimple,
  getModel: mocks.getModel,
}));

describe("--model auto no-model-needed", () => {
  it("skips the model when extracted text fits in desired output tokens", async () => {
    const root = mkdtempSync(join(tmpdir(), "summarize-auto-no-model-needed-"));
    const filePath = join(root, "input.txt");
    writeFileSync(filePath, "hello world", "utf8");

    const stdout = collectStream();
    const stderr = collectStream();

    await runCli(["--model", "auto", "--max-output-tokens", "500", "--plain", filePath], {
      env: { HOME: root, OPENAI_API_KEY: "test" },
      fetch: async () => {
        throw new Error("unexpected fetch");
      },
      stdout: stdout.stream,
      stderr: stderr.stream,
    });

    expect(stdout.getText()).toContain("hello world");
    expect(stderr.getText()).not.toMatch(/model:/i);
    expect(mocks.streamSimple).not.toHaveBeenCalled();
    expect(mocks.completeSimple).not.toHaveBeenCalled();
  });
});
