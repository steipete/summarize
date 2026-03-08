type SlideTextChoice = {
  transcriptText: string;
  ocrText: string;
  preferOcr: boolean;
  holdTranscriptFallback: boolean;
  allowOcrFallback: boolean;
};

export function sanitizeSlideSummaryTitle(title: string): string {
  const normalized = title.trim().replace(/\s+/g, " ");
  if (!normalized) return "";
  const lowered = normalized.toLowerCase();
  if (lowered === "summary" || lowered === "slide summary") return "";
  return normalized;
}

export function chooseSlideDescription({
  transcriptText,
  ocrText,
  preferOcr,
  holdTranscriptFallback,
  allowOcrFallback,
}: SlideTextChoice): string {
  if (preferOcr) return ocrText;
  const ocrFallback = allowOcrFallback ? ocrText : "";
  if (holdTranscriptFallback) return ocrFallback;
  if (!transcriptText && ocrFallback) return ocrFallback;
  return transcriptText;
}
