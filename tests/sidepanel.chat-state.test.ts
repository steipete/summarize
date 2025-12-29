import { describe, expect, it } from 'vitest'

import {
  buildChatRequestMessages,
  compactChatHistory,
  computeChatContextUsage,
  hasUserChatMessage,
} from '../apps/chrome-extension/src/entrypoints/sidepanel/chat-state'
import type { ChatMessage } from '../apps/chrome-extension/src/entrypoints/sidepanel/types'

const limits = { maxMessages: 3, maxChars: 10 }

describe('sidepanel/chat-state', () => {
  it('compacts chat history by max messages and chars', () => {
    const messages: ChatMessage[] = [
      { id: '1', role: 'user', content: 'hello', timestamp: 1 },
      { id: '2', role: 'assistant', content: 'world', timestamp: 2 },
      { id: '3', role: 'user', content: '12345', timestamp: 3 },
      { id: '4', role: 'assistant', content: '67890', timestamp: 4 },
    ]

    const compacted = compactChatHistory(messages, limits)
    expect(compacted.map((m) => m.id)).toEqual(['3', '4'])
  })

  it('computes context usage and user message presence', () => {
    const messages: ChatMessage[] = [
      { id: '1', role: 'assistant', content: 'ok', timestamp: 1 },
      { id: '2', role: 'user', content: 'hi', timestamp: 2 },
    ]

    const usage = computeChatContextUsage(messages, { maxMessages: 100, maxChars: 10 })
    expect(usage.totalChars).toBe(4)
    expect(usage.percent).toBe(40)
    expect(usage.totalMessages).toBe(2)
    expect(hasUserChatMessage(messages)).toBe(true)
  })

  it('builds chat request messages without empty content', () => {
    const messages: ChatMessage[] = [
      { id: '1', role: 'assistant', content: 'hi', timestamp: 1 },
      { id: '2', role: 'user', content: '', timestamp: 2 },
    ]

    expect(buildChatRequestMessages(messages)).toEqual([
      { role: 'assistant', content: 'hi' },
    ])
  })
})
