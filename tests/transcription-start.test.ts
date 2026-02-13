import { describe, expect, it, vi } from 'vitest'

const whisperMock = vi.hoisted(() => ({
  isWhisperCppReady: vi.fn(),
  resolveWhisperCppModelNameForDisplay: vi.fn(),
}))

vi.mock('../packages/core/src/transcription/whisper.js', () => whisperMock)

import { resolveTranscriptionStartInfo } from '../packages/core/src/content/transcript/providers/transcription-start.js'

describe('transcription start helper', () => {
  it('reports unknown when nothing is available', async () => {
    whisperMock.isWhisperCppReady.mockResolvedValue(false)
    whisperMock.resolveWhisperCppModelNameForDisplay.mockResolvedValue(null)

    const startInfo = await resolveTranscriptionStartInfo({
      env: {},
      groqApiKey: null,
      openaiApiKey: null,
      falApiKey: null,
    })

    expect(startInfo.availability.hasAnyProvider).toBe(false)
    expect(startInfo.providerHint).toBe('unknown')
    expect(startInfo.modelId).toBeNull()
  })

  it('prefers ONNX when configured + selected', async () => {
    whisperMock.isWhisperCppReady.mockResolvedValue(false)
    whisperMock.resolveWhisperCppModelNameForDisplay.mockResolvedValue(null)

    const startInfo = await resolveTranscriptionStartInfo({
      env: {
        SUMMARIZE_TRANSCRIBER: 'parakeet',
        SUMMARIZE_ONNX_PARAKEET_CMD: "printf 'ok'",
      },
      groqApiKey: null,
      openaiApiKey: null,
      falApiKey: null,
    })

    expect(startInfo.availability.onnxReady).toBe(true)
    expect(startInfo.providerHint).toBe('onnx')
    expect(startInfo.modelId).toBe('onnx/parakeet')
  })

  it('reports openai->fal when both keys present', async () => {
    whisperMock.isWhisperCppReady.mockResolvedValue(false)
    whisperMock.resolveWhisperCppModelNameForDisplay.mockResolvedValue(null)

    const startInfo = await resolveTranscriptionStartInfo({
      env: {},
      groqApiKey: null,
      openaiApiKey: 'OPENAI',
      falApiKey: 'FAL',
    })

    expect(startInfo.availability.hasAnyProvider).toBe(true)
    expect(startInfo.providerHint).toBe('openai->fal')
    expect(startInfo.modelId).toBe('whisper-1->fal-ai/wizper')
  })

  it('reports cpp when whisper.cpp is ready', async () => {
    whisperMock.isWhisperCppReady.mockResolvedValue(true)
    whisperMock.resolveWhisperCppModelNameForDisplay.mockResolvedValue('tiny.en')

    const startInfo = await resolveTranscriptionStartInfo({
      env: {},
      groqApiKey: null,
      openaiApiKey: null,
      falApiKey: null,
    })

    expect(startInfo.availability.hasAnyProvider).toBe(true)
    expect(startInfo.providerHint).toBe('cpp')
    expect(startInfo.modelId).toBe('tiny.en')
  })
})
