import { runProcessCaptureBuffer, runWithConcurrency } from "./process.js";
import type { SlideImage } from "./types.js";

const TESSERACT_TIMEOUT_MS = 120_000;

export function cleanOcrText(text: string): string {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length >= 2)
    .filter((line) => !(line.length > 20 && !line.includes(" ")))
    .filter((line) => /[a-z0-9]/i.test(line));
  return lines.join("\n");
}

export function estimateOcrConfidence(text: string): number {
  if (!text) return 0;
  const total = text.length;
  if (total === 0) return 0;
  const alnum = Array.from(text).filter((char) => /[a-z0-9]/i.test(char)).length;
  return Math.min(1, alnum / total);
}

export async function runTesseract(tesseractPath: string, imagePath: string): Promise<string> {
  const output = await runProcessCaptureBuffer({
    command: tesseractPath,
    args: [imagePath, "stdout", "--oem", "3", "--psm", "6"],
    timeoutMs: TESSERACT_TIMEOUT_MS,
    errorLabel: "tesseract",
  });
  return output.toString("utf8");
}

export async function runOcrOnSlides(
  slides: SlideImage[],
  tesseractPath: string,
  workers: number,
  onProgress?: ((completed: number, total: number) => void) | null,
): Promise<SlideImage[]> {
  const tasks = slides.map((slide) => async () => {
    try {
      const cleaned = cleanOcrText(await runTesseract(tesseractPath, slide.imagePath));
      return {
        ...slide,
        ocrText: cleaned,
        ocrConfidence: estimateOcrConfidence(cleaned),
      };
    } catch {
      return { ...slide, ocrText: "", ocrConfidence: 0 };
    }
  });
  const results = await runWithConcurrency(tasks, workers, onProgress ?? undefined);
  return results.sort((a, b) => a.index - b.index);
}
