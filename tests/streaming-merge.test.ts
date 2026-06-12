import { describe, expect, it } from "vitest";
import { mergeStreamingChunk } from "../packages/core/src/runtime/streaming-merge.js";

describe("mergeStreamingChunk", () => {
  it("handles empty input", () => {
    expect(mergeStreamingChunk("existing", "")).toEqual({
      next: "existing",
      appended: "",
    });
    expect(mergeStreamingChunk("", "first")).toEqual({
      next: "first",
      appended: "first",
    });
  });

  it("accepts cumulative stream snapshots", () => {
    expect(mergeStreamingChunk("hello", "hello world")).toEqual({
      next: "hello world",
      appended: " world",
    });
    expect(mergeStreamingChunk("hello world", "hello")).toEqual({
      next: "hello world",
      appended: "",
    });
  });

  it("replaces nearly identical longer snapshots", () => {
    const previous = `${"a".repeat(100)} old`;
    const chunk = `${"a".repeat(100)} new ending`;
    expect(mergeStreamingChunk(previous, chunk)).toEqual({
      next: chunk,
      appended: "new ending",
    });
  });

  it("joins overlapping deltas", () => {
    expect(mergeStreamingChunk("hello brave", "brave world")).toEqual({
      next: "hello brave world",
      appended: " world",
    });
  });

  it("appends unrelated deltas", () => {
    expect(mergeStreamingChunk("hello ", "world")).toEqual({
      next: "hello world",
      appended: "world",
    });
  });

  it("normalizes line endings before merging", () => {
    expect(mergeStreamingChunk("hello\r\n", "hello\nworld")).toEqual({
      next: "hello\nworld",
      appended: "world",
    });
  });
});
