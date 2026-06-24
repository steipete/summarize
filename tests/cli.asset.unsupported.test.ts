import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { runCli } from "../src/run.js";

function noopStream() {
  return new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
}
const mocks = vi.hoisted(() => ({
  streamSimple: vi.fn(),
  completeSimple: vi.fn(),
  getModel: vi.fn(() => {
    throw new Error("no model");
  }),
}));

vi.mock("@earendil-works/pi-ai/compat", () => ({
  streamSimple: mocks.streamSimple,
  completeSimple: mocks.completeSimple,
  getModel: mocks.getModel,
}));

describe("cli asset inputs (unsupported by provider)", () => {
  it("prints a friendly error when a provider rejects PDF attachments", async () => {
    mocks.streamSimple.mockImplementation(() => {
      throw new Error("should not be called");
    });
    mocks.completeSimple.mockImplementation(() => {
      throw new Error("should not be called");
    });
    mocks.streamSimple.mockClear();

    const root = mkdtempSync(join(tmpdir(), "summarize-asset-unsupported-"));
    const pdfPath = join(root, "test.pdf");
    writeFileSync(pdfPath, Buffer.from("%PDF-1.7\n%âãÏÓ\n1 0 obj\n<<>>\nendobj\n", "utf8"));

    const run = () =>
      runCli(
        ["--model", "xai/grok-4-fast-non-reasoning", "--timeout", "2s", "--stream", "on", pdfPath],
        {
          env: { XAI_API_KEY: "test" },
          fetch: vi.fn(async () => {
            throw new Error("unexpected fetch");
          }) as unknown as typeof fetch,
          stdout: noopStream(),
          stderr: noopStream(),
        },
      );

    await expect(run()).rejects.toThrow(/uvx\/markitdown/i);
    await expect(run()).rejects.toThrow(/application\/pdf/i);
    expect(mocks.streamSimple).toHaveBeenCalledTimes(0);
  });
});
