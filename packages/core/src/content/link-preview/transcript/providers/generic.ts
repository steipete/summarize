import type { ProviderContext, ProviderFetchOptions, ProviderResult } from '../types.js'

export const canHandle = (): boolean => true

export const fetchTranscript = async (
  _context: ProviderContext,
  _options: ProviderFetchOptions
): Promise<ProviderResult> => {
  await Promise.resolve()
  return {
    text: null,
    source: null,
    attemptedProviders: [],
    metadata: { provider: 'generic', reason: 'not_implemented' },
  }
}
