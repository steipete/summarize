import { describe, expect, it } from "vitest";
import {
  buildFileSummaryPrompt,
  buildFileTextSummaryPrompt,
} from "../packages/core/src/prompts/index.js";
import { parseOutputLanguage } from "../src/language.js";

describe("buildFileSummaryPrompt", () => {
  it("builds a prompt for preset length", () => {
    const prompt = buildFileSummaryPrompt({
      filename: "paper.pdf",
      mediaType: "application/pdf",
      outputLanguage: parseOutputLanguage("English"),
      summaryLength: "short",
    });

    expect(prompt).toContain("<instructions>");
    expect(prompt).toContain("<context>");
    expect(prompt).toContain("Filename: paper.pdf");
    expect(prompt).toContain("Media type: application/pdf");
    expect(prompt).toContain("Target length: around 900 characters");
  });

  it("builds a prompt for soft character targets", () => {
    const prompt = buildFileSummaryPrompt({
      filename: null,
      mediaType: null,
      outputLanguage: parseOutputLanguage("English"),
      summaryLength: { maxCharacters: 20_000 },
      contentLength: 120,
    });

    expect(prompt).toContain("Target length:");
    expect(prompt).toContain("Hard limit");
    expect(prompt).toContain("Extracted content length: 120 characters");
    expect(prompt).not.toContain("Filename:");
    expect(prompt).not.toContain("Media type:");
  });

  it("clamps max characters to content length", () => {
    const prompt = buildFileSummaryPrompt({
      filename: "report.txt",
      mediaType: "text/plain",
      outputLanguage: parseOutputLanguage("English"),
      summaryLength: { maxCharacters: 10_000 },
      contentLength: 120,
    });

    expect(prompt).toContain("Target length: up to 120 characters total");
    expect(prompt).toContain("Extracted content length: 120 characters");
  });

  it("omits header lines when filename and media type are missing", () => {
    const prompt = buildFileSummaryPrompt({
      filename: null,
      mediaType: null,
      outputLanguage: parseOutputLanguage("English"),
      summaryLength: "short",
      contentLength: 0,
    });

    expect(prompt).not.toContain("Filename:");
    expect(prompt).not.toContain("Media type:");
    expect(prompt).not.toContain("Extracted content length:");
  });
});

describe("buildFileTextSummaryPrompt", () => {
  it("keeps attached-file and extracted-text zero-length policies distinct", () => {
    const options = { filename: null, summaryLength: { maxCharacters: 100 }, contentLength: 0 };
    const attached = buildFileSummaryPrompt({ ...options, mediaType: "audio/mpeg" });
    const extracted = buildFileTextSummaryPrompt({
      ...options,
      originalMediaType: "audio/mpeg",
      contentMediaType: "text/plain",
    });
    expect(attached).toContain("Target length: up to 100 characters");
    expect(attached).not.toContain("Extracted content length:");
    expect(extracted).toContain("Target length: up to 0 characters");
    expect(extracted).toContain("Extracted content length: 0 characters");
    expect(attached).toContain("Omit sponsor messages");
    expect(extracted).toContain("Omit sponsor messages");
  });

  it("clamps length to extracted content", () => {
    const prompt = buildFileTextSummaryPrompt({
      filename: "notes.txt",
      originalMediaType: "text/plain",
      contentMediaType: "text/markdown",
      outputLanguage: parseOutputLanguage("English"),
      summaryLength: { maxCharacters: 10_000 },
      contentLength: 300,
      content: "Hello world",
    });

    expect(prompt).toContain("<content>");
    expect(prompt).toContain("Target length: up to 300 characters total");
    expect(prompt).toContain("Original media type: text/plain");
    expect(prompt).toContain("Provided as: text/markdown");
    expect(prompt).toContain("Extracted content length: 300 characters");
  });

  it("omits original media type when missing", () => {
    const prompt = buildFileTextSummaryPrompt({
      filename: null,
      originalMediaType: null,
      contentMediaType: "text/plain",
      outputLanguage: parseOutputLanguage("English"),
      summaryLength: "short",
      contentLength: 120,
      content: "Hello",
    });

    expect(prompt).not.toContain("Original media type:");
    expect(prompt).toContain("Provided as: text/plain");
  });
});
