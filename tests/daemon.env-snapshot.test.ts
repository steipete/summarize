import { describe, expect, it } from "vitest";
import { buildEnvSnapshotFromEnv } from "../src/daemon/env-snapshot.js";

describe("daemon environment snapshot", () => {
  it("preserves the Gemini transcription model override", () => {
    expect(
      buildEnvSnapshotFromEnv({
        SUMMARIZE_GEMINI_TRANSCRIPTION_MODEL: " gemini-2.5-pro ",
      }),
    ).toEqual({
      SUMMARIZE_GEMINI_TRANSCRIPTION_MODEL: "gemini-2.5-pro",
    });
  });
});
