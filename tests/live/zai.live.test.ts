import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { runCli } from "../../src/run.js";

const LIVE = process.env.SUMMARIZE_LIVE_TEST === "1";
const ZAI_KEY = process.env.Z_AI_API_KEY ?? process.env.ZAI_API_KEY ?? null;

function shouldSoftSkipLiveError(message: string): boolean {
  return /(model.*not found|does not exist|permission|access|unauthorized|forbidden|404|not_found|model_not_found)/i.test(
    message,
  );
}

const collectStdout = () => {
  let text = "";
  const stdout = new Writable({
    write(chunk, _encoding, callback) {
      text += chunk.toString();
      callback();
    },
  });
  return { stdout, getText: () => text };
};

const silentStderr = new Writable({
  write(_chunk, _encoding, callback) {
    callback();
  },
});

(LIVE ? describe : describe.skip)("live Z.AI", () => {
  const timeoutMs = 120_000;

  it(
    "zai/glm-4.7 returns text",
    async ({ skip }) => {
      if (!ZAI_KEY) {
        skip("requires Z_AI_API_KEY (or ZAI_API_KEY)");
      }
      try {
        const out = collectStdout();
        await runCli(
          [
            "--model",
            "zai/glm-4.7",
            "--stream",
            "off",
            "--plain",
            "--length",
            "short",
            "--timeout",
            "2m",
            "https://example.com",
          ],
          {
            env: { ...process.env, Z_AI_API_KEY: ZAI_KEY },
            fetch: globalThis.fetch.bind(globalThis),
            stdout: out.stdout,
            stderr: silentStderr,
          },
        );
        expect(out.getText().trim().length).toBeGreaterThan(0);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (shouldSoftSkipLiveError(message)) return;
        throw error;
      }
    },
    timeoutMs,
  );
});
