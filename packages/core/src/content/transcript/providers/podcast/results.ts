import type { ProviderResult } from '../../types.js'
import type { TranscriptionResult } from './media.js'

export function joinNotes(notes: string[]): string | null {
  return notes.length > 0 ? notes.join('; ') : null
}

export function buildWhisperResult({
  attemptedProviders,
  notes,
  outcome,
  metadata,
  includeProviderOnFailure = false,
}: {
  attemptedProviders: ProviderResult['attemptedProviders']
  notes: string[]
  outcome: TranscriptionResult
  metadata: Record<string, unknown>
  includeProviderOnFailure?: boolean
}): ProviderResult {
  if (outcome.text) {
    return {
      text: outcome.text,
      source: 'whisper',
      attemptedProviders,
      notes: joinNotes(notes),
      metadata: {
        ...metadata,
        transcriptionProvider: outcome.provider,
      },
    }
  }

  const failureMetadata =
    includeProviderOnFailure && outcome.provider
      ? { ...metadata, transcriptionProvider: outcome.provider }
      : metadata

  return {
    text: null,
    source: null,
    attemptedProviders,
    notes: outcome.error?.message ?? null,
    metadata: failureMetadata,
  }
}
