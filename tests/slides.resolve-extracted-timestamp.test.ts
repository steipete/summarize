import { describe, expect, it } from "vitest";
import { resolveExtractedTimestamp } from "../src/slides/index.js";

describe("resolveExtractedTimestamp", () => {
  it("falls back to requested when actual is missing", () => {
    expect(resolveExtractedTimestamp({ requested: 12.5, actual: null })).toBe(12.5);
  });

  it("treats small actual values as offsets", () => {
    expect(resolveExtractedTimestamp({ requested: 120.1, actual: 0.4 })).toBeCloseTo(120.5, 4);
  });

  it("uses actual when it looks absolute", () => {
    expect(resolveExtractedTimestamp({ requested: 10, actual: 42.25 })).toBe(42.25);
  });

  it("treats an explicit zero seek base as the input timeline origin", () => {
    expect(resolveExtractedTimestamp({ requested: 4.32, actual: 4.36, seekBase: 0 })).toBeCloseTo(
      4.36,
      4,
    );
  });

  it("prefers base-relative timestamps when closer to requested", () => {
    expect(resolveExtractedTimestamp({ requested: 120, actual: 7.5, seekBase: 112 })).toBeCloseTo(
      119.5,
      2,
    );
  });

  it("prefers absolute timestamps when closer to requested", () => {
    expect(resolveExtractedTimestamp({ requested: 120, actual: 120.2, seekBase: 112 })).toBeCloseTo(
      120.2,
      3,
    );
  });
});
