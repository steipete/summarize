import { afterEach, describe, expect, it, vi } from "vitest";
import { loadWhisperTranscriber } from "../apps/chrome-extension/src/entrypoints/offscreen/whisper";

describe("Chrome local Whisper loader", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("falls back to WASM when WebGPU initialization stalls", async () => {
    vi.useFakeTimers();
    const statuses: string[] = [];
    const transcriber = vi.fn();
    const createPipeline = vi
      .fn()
      .mockImplementationOnce(async () => await new Promise(() => {}))
      .mockResolvedValueOnce(transcriber);

    const result = loadWhisperTranscriber({
      hasWebGpu: true,
      onStatus: (status) => statuses.push(status),
      createPipeline,
      webGpuTimeoutMs: 100,
      wasmTimeoutMs: 100,
    });
    await vi.advanceTimersByTimeAsync(100);

    await expect(result).resolves.toBe(transcriber);
    expect(createPipeline.mock.calls.map(([device]) => device)).toEqual(["webgpu", "wasm"]);
    expect(statuses).toContain("WebGPU model load stalled; retrying on CPU...");
  });

  it("fails instead of hanging when CPU initialization stalls", async () => {
    vi.useFakeTimers();
    const result = loadWhisperTranscriber({
      hasWebGpu: false,
      onStatus: vi.fn(),
      createPipeline: async () => await new Promise(() => {}),
      wasmTimeoutMs: 100,
    });
    const rejection = expect(result).rejects.toThrow("CPU Whisper model initialization timed out.");
    await vi.advanceTimersByTimeAsync(100);

    await rejection;
  });
});
