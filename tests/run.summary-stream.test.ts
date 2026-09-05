import { describe, expect, it, vi } from "vitest";
import { createTerminalSummaryStream } from "../src/run/summary-stream.js";
import { captureStream as collectStream } from "./helpers/streams.js";

describe("terminal summary stream", () => {
  it("renders engine deltas through the plain output adapter", async () => {
    const output = collectStream();
    const clearProgressForStdout = vi.fn();
    const restoreProgressAfterStdout = vi.fn();
    const stream = createTerminalSummaryStream({
      stdout: output.stream,
      env: {},
      envForRun: {},
      plain: true,
      outputMode: "delta",
      clearProgressForStdout,
      restoreProgressAfterStdout,
    });

    expect(stream.onChunk({ streamed: "Hello", prevStreamed: "", appended: "Hello" })).toBe(true);
    expect(
      stream.onChunk({
        streamed: "Hello world",
        prevStreamed: "Hello",
        appended: " world",
      }),
    ).toBe(true);
    await stream.onDone?.("Hello world");

    expect(output.getText()).toBe("Hello world\n");
    expect(clearProgressForStdout).toHaveBeenCalled();
    expect(restoreProgressAfterStdout).toHaveBeenCalledTimes(1);
  });

  it("reports buffered line output and discards it on reset", async () => {
    const output = collectStream();
    const stream = createTerminalSummaryStream({
      stdout: output.stream,
      env: {},
      envForRun: {},
      plain: true,
      outputMode: "line",
      clearProgressForStdout: vi.fn(),
    });

    expect(stream.onChunk({ streamed: "Buffered", prevStreamed: "", appended: "Buffered" })).toBe(
      false,
    );
    await stream.onReset();
    expect(
      stream.onChunk({ streamed: "Fallback\n", prevStreamed: "", appended: "Fallback\n" }),
    ).toBe(true);
    await stream.onDone?.("Fallback\n");

    expect(output.getText()).toBe("Fallback\n");
  });
});
