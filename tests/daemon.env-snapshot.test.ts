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

  it("preserves Devin CLI binary and XDG/credential overrides", () => {
    expect(
      buildEnvSnapshotFromEnv({
        DEVIN_PATH: " /opt/devin/devin ",
        XDG_CONFIG_HOME: "/xdg/config",
        XDG_DATA_HOME: "/xdg/data",
        WINDSURF_API_KEY: "secret-key",
      }),
    ).toEqual({
      DEVIN_PATH: "/opt/devin/devin",
      XDG_CONFIG_HOME: "/xdg/config",
      XDG_DATA_HOME: "/xdg/data",
      WINDSURF_API_KEY: "secret-key",
    });
  });
});
