type SlideTextChoice = {
  summaryText: string;
  transcriptText: string;
  ocrText: string;
  preferOcr: boolean;
  allowOcrFallback: boolean;
};

export function sanitizeSlideSummaryTitle(title: string): string {
  const normalized = title.trim().replace(/\s+/g, " ");
  if (!normalized) return "";
  const lowered = normalized.toLowerCase();
  if (
    lowered === "summary" ||
    lowered ===
      /* i18n-ignore: Canonical model-output heading, independent of UI locale. */ "slide summary"
  )
    return "";
  return normalized;
}

export function chooseSlideDescription({
  summaryText,
  transcriptText,
  ocrText,
  preferOcr,
  allowOcrFallback,
}: SlideTextChoice): string {
  if (preferOcr) return ocrText;
  if (summaryText) return summaryText;
  const ocrFallback = allowOcrFallback ? ocrText : "";
  if (!transcriptText && ocrFallback) return ocrFallback;
  return transcriptText;
}
