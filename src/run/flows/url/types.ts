import type { CacheState } from '../../../cache.js'
import type { SummarizeConfig } from '../../../config.js'
import type { ExtractedLinkContent, LinkPreviewProgressEvent } from '../../../content/index.js'
import type { LlmCall, RunMetricsReport } from '../../../costs.js'
import type { OutputLanguage } from '../../../language.js'
import type { ExecFileFn } from '../../../markitdown.js'
import type { FixedModelSpec, RequestedModel } from '../../../model-spec.js'
import type { SummaryLength } from '../../../shared/contracts.js'
import type {
  SlideExtractionResult,
  SlideImage,
  SlideSettings,
  SlideSourceKind,
} from '../../../slides/index.js'
import type { createSummaryEngine } from '../../summary-engine.js'
import type { SummarizeAssetArgs } from '../asset/summary.js'

export type UrlFlowIo = {
  env: Record<string, string | undefined>
  envForRun: Record<string, string | undefined>
  stdout: NodeJS.WritableStream
  stderr: NodeJS.WritableStream
  execFileImpl: ExecFileFn
  fetch: typeof fetch
}

export type UrlFlowFlags = {
  timeoutMs: number
  maxExtractCharacters?: number | null
  retries: number
  format: 'text' | 'markdown'
  markdownMode: 'off' | 'auto' | 'llm' | 'readability'
  preprocessMode: 'off' | 'auto' | 'always'
  youtubeMode: 'auto' | 'web' | 'yt-dlp' | 'apify' | 'no-auto'
  firecrawlMode: 'off' | 'auto' | 'always'
  videoMode: 'auto' | 'transcript' | 'understand'
  transcriptTimestamps: boolean
  outputLanguage: OutputLanguage
  lengthArg: { kind: 'preset'; preset: SummaryLength } | { kind: 'chars'; maxCharacters: number }
  forceSummary: boolean
  promptOverride?: string | null
  lengthInstruction?: string | null
  languageInstruction?: string | null
  maxOutputTokensArg: number | null
  json: boolean
  extractMode: boolean
  metricsEnabled: boolean
  metricsDetailed: boolean
  shouldComputeReport: boolean
  runStartedAtMs: number
  verbose: boolean
  verboseColor: boolean
  progressEnabled: boolean
  streamingEnabled: boolean
  plain: boolean
  configPath: string | null
  configModelLabel: string | null
  slides: SlideSettings | null
  slidesDebug: boolean
}

export type UrlFlowModel = {
  requestedModel: RequestedModel
  requestedModelInput: string
  requestedModelLabel: string
  fixedModelSpec: FixedModelSpec | null
  isFallbackModel: boolean
  isNamedModelSelection: boolean
  wantsFreeNamedModel: boolean
  desiredOutputTokens: number | null
  configForModelSelection: SummarizeConfig | null
  envForAuto: Record<string, string | undefined>
  cliAvailability: Partial<Record<'claude' | 'codex' | 'gemini', boolean>>
  openaiUseChatCompletions: boolean
  openaiWhisperUsdPerMinute: number
  apiStatus: {
    xaiApiKey: string | null
    apiKey: string | null
    openrouterApiKey: string | null
    openrouterConfigured: boolean
    googleApiKey: string | null
    googleConfigured: boolean
    anthropicApiKey: string | null
    anthropicConfigured: boolean
    providerBaseUrls: {
      openai: string | null
      anthropic: string | null
      google: string | null
      xai: string | null
    }
    zaiApiKey: string | null
    zaiBaseUrl: string
    firecrawlConfigured: boolean
    firecrawlApiKey: string | null
    apifyToken: string | null
    ytDlpPath: string | null
    falApiKey: string | null
    openaiTranscriptionKey: string | null
  }
  summaryEngine: ReturnType<typeof createSummaryEngine>
  getLiteLlmCatalog: () => Promise<
    Awaited<ReturnType<typeof import('../../../pricing/litellm.js').loadLiteLlmCatalog>>['catalog']
  >
  llmCalls: LlmCall[]
}

export type UrlFlowHooks = {
  onModelChosen?: ((modelId: string) => void) | null
  onExtracted?: ((extracted: ExtractedLinkContent) => void) | null
  onSlidesExtracted?: ((slides: SlideExtractionResult) => void) | null
  onSlidesProgress?: ((text: string) => void) | null
  onSlidesDone?: ((result: { ok: boolean; error?: string | null }) => void) | null
  onSlideChunk?: (chunk: {
    slide: SlideImage
    meta: {
      slidesDir: string
      sourceUrl: string
      sourceId: string
      sourceKind: SlideSourceKind
      ocrAvailable: boolean
    }
  }) => void
  onLinkPreviewProgress?: ((event: LinkPreviewProgressEvent) => void) | null
  onSummaryCached?: ((cached: boolean) => void) | null
  setTranscriptionCost: (costUsd: number | null, label: string | null) => void
  summarizeAsset: (args: SummarizeAssetArgs) => Promise<void>
  writeViaFooter: (parts: string[]) => void
  clearProgressForStdout: () => void
  restoreProgressAfterStdout?: (() => void) | null
  setClearProgressBeforeStdout: (fn: (() => undefined | (() => void)) | null) => void
  clearProgressIfCurrent: (fn: () => void) => void
  buildReport: () => Promise<RunMetricsReport>
  estimateCostUsd: () => Promise<number | null>
}

/**
 * Wiring struct for `runUrlFlow`.
 * CLI runner populates the full surface; daemon uses a smaller subset (no TTY/progress/footer),
 * but both share the same extraction/cache/model logic.
 */
export type UrlFlowContext = {
  io: UrlFlowIo
  flags: UrlFlowFlags
  model: UrlFlowModel
  cache: CacheState
  hooks: UrlFlowHooks
}
