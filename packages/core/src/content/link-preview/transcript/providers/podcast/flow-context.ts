import type { ProviderContext, ProviderFetchOptions, ProviderResult } from '../../types.js'
import type { TranscribeRequest, TranscriptionResult } from './media.js'

export type PodcastFlowContext = {
  context: ProviderContext
  options: ProviderFetchOptions
  attemptedProviders: ProviderResult['attemptedProviders']
  notes: string[]
  pushOnce: (provider: ProviderResult['attemptedProviders'][number]) => void
  ensureTranscriptionProvider: () => ProviderResult | null
  transcribe: (request: TranscribeRequest) => Promise<TranscriptionResult>
}
