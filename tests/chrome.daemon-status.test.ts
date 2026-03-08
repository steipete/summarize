import { describe, expect, it } from "vitest";
import {
  createDaemonStatusTracker,
  isTransientDaemonState,
} from "../apps/chrome-extension/src/lib/daemon-status.js";

describe("chrome/daemon-status", () => {
  it("keeps the last ready state during active runs on timeout", () => {
    const tracker = createDaemonStatusTracker({ transientGraceMs: 10 });

    expect(tracker.resolve({ ok: true, authed: true }, { now: 1_000 })).toEqual({
      ok: true,
      authed: true,
    });

    expect(
      tracker.resolve(
        { ok: false, authed: false, error: "Timed out" },
        { now: 50_000, keepReady: true },
      ),
    ).toEqual({ ok: true, authed: true });
  });

  it("keeps the last ready state briefly after a transient probe failure", () => {
    const tracker = createDaemonStatusTracker({ transientGraceMs: 5_000 });

    tracker.resolve({ ok: true, authed: true }, { now: 1_000 });

    expect(
      tracker.resolve({ ok: false, authed: false, error: "Timed out" }, { now: 5_500 }),
    ).toEqual({ ok: true, authed: true });
  });

  it("surfaces transient failures after the grace window expires", () => {
    const tracker = createDaemonStatusTracker({ transientGraceMs: 5_000 });

    tracker.resolve({ ok: true, authed: true }, { now: 1_000 });

    expect(
      tracker.resolve({ ok: false, authed: false, error: "Timed out" }, { now: 7_000 }),
    ).toEqual({ ok: false, authed: false, error: "Timed out" });
  });

  it("treats successful non-health daemon calls as ready", () => {
    const tracker = createDaemonStatusTracker({ transientGraceMs: 5_000 });

    tracker.markReady(1_000);

    expect(
      tracker.resolve({ ok: false, authed: false, error: "Timed out" }, { now: 4_000 }),
    ).toEqual({ ok: true, authed: true });
  });

  it("surfaces non-transient auth failures immediately", () => {
    const tracker = createDaemonStatusTracker({ transientGraceMs: 60_000 });

    tracker.resolve({ ok: true, authed: true }, { now: 1_000 });

    expect(
      tracker.resolve({ ok: true, authed: false, error: "401 Unauthorized" }, { now: 2_000 }),
    ).toEqual({ ok: true, authed: false, error: "401 Unauthorized" });
  });

  it("detects transient daemon probe failures", () => {
    expect(isTransientDaemonState({ ok: false, authed: false, error: "Timed out" })).toBe(true);
    expect(
      isTransientDaemonState({
        ok: false,
        authed: false,
        error: "Failed to fetch (daemon unreachable or blocked by Chrome)",
      }),
    ).toBe(true);
    expect(isTransientDaemonState({ ok: true, authed: false, error: "401 Unauthorized" })).toBe(
      false,
    );
  });
});
