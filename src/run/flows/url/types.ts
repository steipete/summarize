import type { SummarizeConfig } from '../../../config.js'
import type { LlmCall, RunMetricsReport } from '../../../costs.js'
import type { OutputLanguage } from '../../../language.js'
import type { ExecFileFn } from '../../../markitdown.js'
import type { FixedModelSpec, RequestedModel } from '../../../model-spec.js'
import type { SummaryLength } from '../../../shared/contracts.js'
import type { createSummaryEngine } from '../../summary-engine.js'
import type { SummarizeAssetArgs } from '../asset/summary.js'

export type UrlFlowContext = {
  env: Record<string, string | undefined>
  envForRun: Record<string, string | undefined>
  stdout: NodeJS.WritableStream
  stderr: NodeJS.WritableStream
  execFileImpl: ExecFileFn
  timeoutMs: number
  retries: number
  format: 'text' | 'markdown'
  markdownMode: 'off' | 'auto' | 'llm' | 'readability'
  preprocessMode: 'off' | 'auto' | 'always'
  youtubeMode: 'auto' | 'web' | 'yt-dlp' | 'apify'
  firecrawlMode: 'off' | 'auto' | 'always'
  videoMode: 'auto' | 'transcript' | 'understand'
  outputLanguage: OutputLanguage
  lengthArg: { kind: 'preset'; preset: SummaryLength } | { kind: 'chars'; maxCharacters: number }
  maxOutputTokensArg: number | null
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
  openaiUseChatCompletions: boolean
  configPath: string | null
  configModelLabel: string | null
  openaiWhisperUsdPerMinute: number
  setTranscriptionCost: (costUsd: number | null, label: string | null) => void
  apiStatus: {
    xaiApiKey: string | null
    apiKey: string | null
    openrouterApiKey: string | null
    openrouterConfigured: boolean
    googleApiKey: string | null
    googleConfigured: boolean
    anthropicApiKey: string | null
    anthropicConfigured: boolean
    zaiApiKey: string | null
    zaiBaseUrl: string
    firecrawlConfigured: boolean
    firecrawlApiKey: string | null
    apifyToken: string | null
    ytDlpPath: string | null
    falApiKey: string | null
    openaiTranscriptionKey: string | null
    providerBaseUrls: {
      openai: string | null
      anthropic: string | null
      google: string | null
      xai: string | null
    }
  }
  trackedFetch: typeof fetch
  summaryEngine: ReturnType<typeof createSummaryEngine>
  summarizeAsset: (args: SummarizeAssetArgs) => Promise<void>
  writeViaFooter: (parts: string[]) => void
  clearProgressForStdout: () => void
  setClearProgressBeforeStdout: (fn: (() => void) | null) => void
  clearProgressIfCurrent: (fn: () => void) => void
  getLiteLlmCatalog: () => Promise<
    Awaited<ReturnType<typeof import('../../../pricing/litellm.js').loadLiteLlmCatalog>>['catalog']
  >
  buildReport: () => Promise<RunMetricsReport>
  estimateCostUsd: () => Promise<number | null>
  llmCalls: LlmCall[]
}
