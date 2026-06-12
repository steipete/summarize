import { describe, expect, it } from "vitest";
import { SUMMARY_LENGTHS as CONTRACT_LENGTHS } from "../packages/core/src/shared/contracts.js";
import { SUMMARY_LENGTHS as INDEX_LENGTHS } from "../src/index.js";

describe("summarizer entrypoints", () => {
  it("exports summary length presets", () => {
    expect(INDEX_LENGTHS).toEqual(["short", "medium", "long", "xl", "xxl"]);
    expect(CONTRACT_LENGTHS).toEqual(["short", "medium", "long", "xl", "xxl"]);
  });
});
