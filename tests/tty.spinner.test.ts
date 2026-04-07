import { Writable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { startSpinner } from "../src/tty/spinner.js";

const { oraMock } = vi.hoisted(() => ({
  oraMock: vi.fn(),
}));

vi.mock("ora", () => ({
  default: oraMock,
}));

const stream = new Writable({
  write(_chunk, _encoding, callback) {
    callback();
  },
});

describe("tty spinner", () => {
  it("returns no-op handlers when disabled", () => {
    oraMock.mockReset();

    const spinner = startSpinner({ text: "Loading", enabled: false, stream });
    spinner.stop();
    spinner.clear();
    spinner.stopAndClear();
    spinner.setText("Next");

    expect(oraMock).not.toHaveBeenCalled();
  });

  it("does not stop when already stopped", () => {
    oraMock.mockReset();
    const stopSpy = vi.fn();
    oraMock.mockImplementationOnce(() => ({
      isSpinning: false,
      text: "Loading",
      stop: stopSpy,
      clear: vi.fn(),
      start() {
        return this;
      },
    }));

    const spinner = startSpinner({ text: "Loading", enabled: true, stream });
    spinner.stop();

    expect(stopSpy).not.toHaveBeenCalled();
  });

  it("pauses, resumes, and clears when enabled", () => {
    oraMock.mockReset();
    const stopSpy = vi.fn();
    const clearSpy = vi.fn();
    const startSpy = vi.fn(function (this: { isSpinning: boolean }) {
      this.isSpinning = true;
      return this;
    });
    const renderSpy = vi.fn();
    const spinnerState = {
      isSpinning: true,
      text: "Loading",
      stop: stopSpy,
      clear: clearSpy,
      render: renderSpy,
      start: startSpy,
    };
    oraMock.mockImplementationOnce(() => spinnerState);

    let writes = "";
    const writable = new Writable({
      write(chunk, _encoding, callback) {
        writes += chunk.toString();
        callback();
      },
    });

    const spinner = startSpinner({ text: "Loading", enabled: true, stream: writable });
    spinner.pause();
    spinner.setText("Paused");
    spinner.pause();
    spinner.resume();
    spinner.stopAndClear();
    spinner.clear();

    expect(stopSpy).toHaveBeenCalled();
    expect(clearSpy).toHaveBeenCalled();
    expect(startSpy).toHaveBeenCalled();
    expect(renderSpy).not.toHaveBeenCalled();
    expect(writes).toContain("\u001b[2K");
  });

  it("ignores empty/ansi-only and duplicate text updates", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    oraMock.mockReset();
    const renderSpy = vi.fn();
    const spinnerState = {
      isSpinning: true,
      text: "Loading",
      stop: vi.fn(),
      clear: vi.fn(),
      render: renderSpy,
      start() {
        return this;
      },
    };
    oraMock.mockImplementationOnce(() => spinnerState);

    const spinner = startSpinner({ text: "Loading", enabled: true, stream });
    spinner.setText("   ");
    spinner.setText("\u001b[36m\u001b[0m");
    spinner.setText("Loading");
    spinner.setText("Next");
    vi.setSystemTime(1_050);
    spinner.setText("Later");
    vi.setSystemTime(1_100);
    spinner.setText("Latest");

    expect(renderSpy).toHaveBeenCalledTimes(2);
    expect(spinnerState.text).toBe("Latest");
    vi.useRealTimers();
  });

  it("can refresh the current line after external terminal writes", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    oraMock.mockReset();
    const renderSpy = vi.fn();
    const spinnerState = {
      isSpinning: true,
      text: "Loading",
      stop: vi.fn(),
      clear: vi.fn(),
      render: renderSpy,
      start() {
        return this;
      },
    };
    oraMock.mockImplementationOnce(() => spinnerState);

    const spinner = startSpinner({ text: "Loading", enabled: true, stream });
    spinner.refresh();
    vi.setSystemTime(1_050);
    spinner.refresh();
    vi.setSystemTime(1_100);
    spinner.refresh();

    expect(renderSpy).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });
});
