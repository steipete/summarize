import { describe, expect, it } from "vitest";
import {
  formatOutputLanguageForJson,
  formatOutputLanguageInstruction,
  parseOutputLanguage,
  resolveOutputLanguage,
} from "../src/language.js";

describe("output language", () => {
  it("parses auto", () => {
    expect(parseOutputLanguage("auto")).toEqual({ kind: "auto" });
  });

  it("parses common aliases", () => {
    expect(parseOutputLanguage("en")).toEqual({ kind: "fixed", tag: "en", label: "English" });
    expect(parseOutputLanguage("English")).toEqual({ kind: "fixed", tag: "en", label: "English" });
    expect(parseOutputLanguage("de")).toEqual({ kind: "fixed", tag: "de", label: "German" });
    expect(parseOutputLanguage("Deutsch")).toEqual({ kind: "fixed", tag: "de", label: "German" });
    expect(parseOutputLanguage("zh-tw")).toEqual({
      kind: "fixed",
      tag: "zh-TW",
      label: "Traditional Chinese",
    });
    expect(parseOutputLanguage("Traditional Chinese")).toEqual({
      kind: "fixed",
      tag: "zh-TW",
      label: "Traditional Chinese",
    });
    expect(parseOutputLanguage("pt-BR")).toEqual({
      kind: "fixed",
      tag: "pt-BR",
      label: "Portuguese (Brazil)",
    });
  });

  it("normalizes BCP-47-ish tags", () => {
    expect(parseOutputLanguage("EN-us")).toEqual({ kind: "fixed", tag: "en-US", label: "English" });
    expect(parseOutputLanguage("pt_br")).toEqual({
      kind: "fixed",
      tag: "pt-BR",
      label: "Portuguese (Brazil)",
    });
    expect(parseOutputLanguage("sr-latn_rs")).toEqual({
      kind: "fixed",
      tag: "sr-Latn-RS",
      label: "sr-Latn-RS",
    });
  });

  it("keeps natural language hints", () => {
    expect(parseOutputLanguage("German, formal")).toEqual({
      kind: "fixed",
      tag: "German, formal",
      label: "German, formal",
    });
  });

  it("sanitizes free-form hints (collapse + truncate)", () => {
    expect(parseOutputLanguage("German     (formal)")).toEqual({
      kind: "fixed",
      tag: "German (formal)",
      label: "German (formal)",
    });

    const long = "german very formal polite writing style with extra constraints please";
    const parsed = parseOutputLanguage(long);
    expect(parsed.kind).toBe("fixed");
    if (parsed.kind === "fixed") {
      expect(parsed.tag.length).toBeLessThanOrEqual(64);
      expect(parsed.label.length).toBeLessThanOrEqual(64);
    }
  });

  it("formats prompt instruction", () => {
    expect(formatOutputLanguageInstruction({ kind: "auto" })).toMatch(/dominant source language/i);
    expect(formatOutputLanguageInstruction({ kind: "fixed", tag: "en", label: "English" })).toBe(
      "Write the answer in English.",
    );
    expect(
      formatOutputLanguageInstruction({
        kind: "fixed",
        tag: "zh-TW",
        label: "Traditional Chinese",
      }),
    ).toBe(
      "Write the answer in Traditional Chinese (zh-Hant) using Traditional Chinese characters. Do not answer in English except for unavoidable source quotes or proper nouns.",
    );
  });

  it("formats JSON output language", () => {
    expect(formatOutputLanguageForJson({ kind: "auto" })).toEqual({ mode: "auto" });
    expect(formatOutputLanguageForJson({ kind: "fixed", tag: "en", label: "English" })).toEqual({
      mode: "fixed",
      tag: "en",
      label: "English",
    });
  });

  it("resolves missing/empty to auto", () => {
    expect(resolveOutputLanguage(null)).toEqual({ kind: "auto" });
    expect(resolveOutputLanguage(undefined)).toEqual({ kind: "auto" });
    expect(resolveOutputLanguage("   ")).toEqual({ kind: "auto" });
  });

  it("rejects empty", () => {
    expect(() => parseOutputLanguage("  ")).toThrow(/must not be empty/i);
  });
});
