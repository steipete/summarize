import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanOcrText, estimateOcrConfidence, runTesseract } from "../src/slides/ocr.js";
import * as processHelpers from "../src/slides/process.js";

afterEach(() => vi.restoreAllMocks());

describe("slides ocr helpers", () => {
  it("runs OCR through binary capture without logging recognized text", async () => {
    const capture = vi
      .spyOn(processHelpers, "runProcessCaptureBuffer")
      .mockResolvedValue(Buffer.from("Résumé\n"));
    await expect(runTesseract("custom-tesseract", "/tmp/frame.png")).resolves.toBe("Résumé\n");
    expect(capture).toHaveBeenCalledExactlyOnceWith({
      command: "custom-tesseract",
      args: ["/tmp/frame.png", "stdout", "--oem", "3", "--psm", "6"],
      timeoutMs: 120_000,
      errorLabel: "tesseract",
    });
  });
  it("cleans noisy lines and keeps readable content", () => {
    expect(
      cleanOcrText(
        [
          "A",
          "Readable title",
          "SUPERCALIFRAGILISTICEXPIALIDOCIOUS",
          "###",
          "second line 123",
        ].join("\n"),
      ),
    ).toBe("Readable title\nsecond line 123");
  });

  it("estimates confidence from alphanumeric density", () => {
    expect(estimateOcrConfidence("")).toBe(0);
    expect(estimateOcrConfidence("abc123")).toBe(1);
    expect(estimateOcrConfidence("abc!!!")).toBeCloseTo(0.5, 2);
  });
});
