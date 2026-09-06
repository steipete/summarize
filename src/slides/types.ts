export const SLIDE_EXTRACTION_VERSION = 1;

export type SlideSourceKind = "youtube" | "direct";

export type SlideSource = {
  url: string;
  kind: SlideSourceKind;
  sourceId: string;
};

export type SlideImage = {
  index: number;
  timestamp: number;
  imagePath: string;
  /**
   * Bump when the underlying image file changes (e.g. thumbnail improvement),
   * so clients can cache-bust URLs.
   */
  imageVersion?: number;
  ocrText?: string | null;
  ocrConfidence?: number | null;
};

export type SlideAutoTune = {
  enabled: boolean;
  chosenThreshold: number;
  confidence: number;
  strategy: "hash" | "none";
};

export type SlideExtractionResult = {
  extractorVersion?: number;
  sourceUrl: string;
  sourceKind: SlideSourceKind;
  sourceId: string;
  slidesDir: string;
  slidesDirId?: string | null;
  sceneThreshold: number;
  autoTuneThreshold: boolean;
  autoTune: SlideAutoTune;
  maxSlides: number;
  minSlideDuration: number;
  ocrRequested: boolean;
  ocrAvailable: boolean;
  slides: SlideImage[];
  warnings: string[];
};
