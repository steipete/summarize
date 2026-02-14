import { describe, expect, it } from "vitest";
import { createProgressGate } from "../src/run/progress.js";

describe("progress gate", () => {
  it("clears once and keeps progress hidden after stdout starts", () => {
    const events: string[] = [];
    const gate = createProgressGate();
    gate.setClearProgressBeforeStdout(() => {
      events.push("clear");
      return () => events.push("restore");
    });

    gate.clearProgressForStdout();
    gate.restoreProgressAfterStdout();
    gate.clearProgressForStdout();

    expect(events).toEqual(["clear"]);
  });

  it("accepts a new clear function after previous one is detached", () => {
    const events: string[] = [];
    const gate = createProgressGate();
    gate.setClearProgressBeforeStdout(() => {
      events.push("first-clear");
      return () => events.push("first-restore");
    });
    gate.clearProgressForStdout();

    gate.setClearProgressBeforeStdout(() => {
      events.push("second-clear");
      return () => events.push("second-restore");
    });
    gate.clearProgressForStdout();

    expect(events).toEqual(["first-clear", "second-clear"]);
  });
});
