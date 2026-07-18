import { describe, expect, it, vi } from "vitest";
import {
  createOscProgressController,
  startOscProgress,
  supportsOscProgress,
} from "../src/tty/osc-progress.js";

describe("osc-progress", () => {
  it("detects support based on env + tty", () => {
    expect(supportsOscProgress({}, false)).toBe(false);
    expect(supportsOscProgress({ TERM_PROGRAM: "ghostty" }, true)).toBe(true);
    expect(supportsOscProgress({ TERM_PROGRAM: "wezterm" }, true)).toBe(true);
    expect(supportsOscProgress({ WT_SESSION: "1" }, true)).toBe(true);
    expect(supportsOscProgress({ TERM_PROGRAM: "Terminal.app" }, true)).toBe(false);
  });

  it("writes indeterminate begin/end frames and sanitizes labels", () => {
    const writes: string[] = [];
    const stop = startOscProgress({
      env: { TERM_PROGRAM: "ghostty" },
      isTty: true,
      indeterminate: true,
      label: "Load\u001b[31m]\u0007\u009c  file  ",
      write: (data) => writes.push(data),
    });

    stop();

    expect(writes.length).toBe(2);
    expect(writes[0]).toContain("\u001b]9;4;3;;Load[31m]  file\u001b\\");
    expect(writes[1]).toContain("\u001b]9;4;0;0;Load[31m]  file\u001b\\");
  });

  it("writes determinate updates and stops cleanly", () => {
    vi.useFakeTimers();
    const writes: string[] = [];
    const stop = startOscProgress({
      env: { WT_SESSION: "1" },
      isTty: true,
      indeterminate: false,
      label: "Fetching",
      write: (data) => writes.push(data),
    });

    // Initial frame.
    expect(writes[0]).toContain("\u001b]9;4;1;0;Fetching\u001b\\");

    // Tick once.
    vi.advanceTimersByTime(950);
    expect(writes.some((w) => w.includes("\u001b]9;4;1;"))).toBe(true);

    stop();
    expect(writes[writes.length - 1]).toContain("\u001b]9;4;0;0;Fetching\u001b\\");

    vi.useRealTimers();
  });

  it("supports stateful updates via createOscProgressController", () => {
    const writes: string[] = [];
    const osc = createOscProgressController({
      env: { TERM_PROGRAM: "wezterm" },
      isTty: true,
      label: "Init",
      write: (data) => writes.push(data),
    });

    osc.setIndeterminate("Waiting");
    osc.setPercent("Transcribing", 50);
    osc.clear();

    expect(writes[0]).toContain("]9;4;3;;Waiting");
    expect(writes[1]).toContain("]9;4;1;50;Transcribing");
    expect(writes[2]).toContain("]9;4;0;0;Transcribing");
  });

  it("holds indeterminate updates briefly after a percent update", () => {
    vi.useFakeTimers();
    const writes: string[] = [];
    const osc = createOscProgressController({
      env: { TERM_PROGRAM: "wezterm" },
      isTty: true,
      label: "Init",
      write: (data) => writes.push(data),
    });

    osc.setPercent("Downloading", 25);
    osc.setIndeterminate("Waiting");
    expect(writes).toHaveLength(1);
    expect(writes[0]).toContain("]9;4;1;25;Downloading");

    vi.advanceTimersByTime(2001);
    osc.setIndeterminate("Waiting");
    expect(writes).toHaveLength(2);
    expect(writes[1]).toContain("]9;4;3;;Waiting");

    vi.useRealTimers();
  });

  it("allows indeterminate updates again after clear resets progress state", () => {
    const writes: string[] = [];
    const osc = createOscProgressController({
      env: { TERM_PROGRAM: "wezterm" },
      isTty: true,
      label: "Init",
      write: (data) => writes.push(data),
    });

    osc.setPercent("Downloading", 25);
    osc.clear();
    osc.setIndeterminate("Waiting");

    expect(writes[0]).toContain("]9;4;1;25;Downloading");
    expect(writes[1]).toContain("]9;4;0;0;Downloading");
    expect(writes[2]).toContain("]9;4;3;;Waiting");
  });
});
