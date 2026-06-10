import { describe, expect, it } from "vitest";
import {
  jsonTranscriptToSegments,
  vttToSegments,
} from "../packages/core/src/content/transcript/parse.js";
import {
  formatTimestampMs,
  formatTranscriptSegments,
  parseTimestampStringToMs,
  parseTimestampToMs,
} from "../packages/core/src/content/transcript/timestamps.js";

describe("transcript timestamp helpers", () => {
  it("formats and parses timestamps", () => {
    expect(formatTimestampMs(0)).toBe("0:00");
    expect(formatTimestampMs(61_000)).toBe("1:01");
    expect(formatTimestampMs(3_661_000)).toBe("1:01:01");

    expect(parseTimestampStringToMs("1:02")).toBe(62_000);
    expect(parseTimestampStringToMs("01:02:03")).toBe(3_723_000);
    expect(parseTimestampStringToMs("1:02.500")).toBe(62_500);
    expect(parseTimestampStringToMs("01:02:03.500")).toBe(3_723_500);
    expect(parseTimestampStringToMs("1:60")).toBeNull();
    expect(parseTimestampStringToMs("1:02:60")).toBeNull();
    expect(parseTimestampStringToMs("1:60:00")).toBeNull();
    expect(parseTimestampStringToMs("1.5:02")).toBeNull();
    expect(parseTimestampStringToMs("1.5:02:03")).toBeNull();
    expect(parseTimestampStringToMs("1:02.5:03")).toBeNull();
    expect(parseTimestampStringToMs("bad")).toBeNull();

    expect(parseTimestampToMs(1.5, true)).toBe(1500);
    expect(parseTimestampToMs("2.5", true)).toBe(2500);
    expect(parseTimestampToMs("1200", false)).toBe(1200);
  });

  it("parses VTT cues into segments", () => {
    const vtt = [
      "WEBVTT",
      "",
      "00:00:01.000 --> 00:00:02.500",
      "Hello world",
      "",
      "00:00:03.000 --> 00:00:04.000",
      "Again",
      "",
    ].join("\n");

    expect(vttToSegments(vtt)).toEqual([
      { startMs: 1000, endMs: 2500, text: "Hello world" },
      { startMs: 3000, endMs: 4000, text: "Again" },
    ]);
  });

  it("parses JSON transcript payloads into segments", () => {
    const payload = [
      { text: "Hello", start: 1.5, end: 3.5 },
      { utf8: "world", start: 4, end: 5 },
    ];

    expect(jsonTranscriptToSegments(payload)).toEqual([
      { startMs: 1500, endMs: 3500, text: "Hello" },
      { startMs: 4000, endMs: 5000, text: "world" },
    ]);
  });

  it("formats transcript segments into timed text", () => {
    const text = formatTranscriptSegments([{ startMs: 1000, endMs: 2000, text: "Hello" }]);
    expect(text).toBe("[0:01] Hello");
  });

  it("includes speaker labels in timed transcript lines", () => {
    const text = formatTranscriptSegments([
      { startMs: 1000, endMs: 2000, text: "Hello", speaker: "Speaker 1" },
    ]);
    expect(text).toBe("[0:01] Speaker 1: Hello");
  });
});
