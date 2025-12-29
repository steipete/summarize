import type { ChatMessage } from './types'

export type ChatHistoryLimits = {
  maxMessages: number
  maxChars: number
}

export type ChatContextUsage = {
  totalChars: number
  percent: number
  totalMessages: number
}

export function compactChatHistory(
  messages: ChatMessage[],
  limits: ChatHistoryLimits
): ChatMessage[] {
  const filtered = messages.filter((msg) => msg.content.trim().length > 0)
  const trimmed: ChatMessage[] = []
  let totalChars = 0
  for (let i = filtered.length - 1; i >= 0; i -= 1) {
    const msg = filtered[i]
    const len = msg.content.length
    if (trimmed.length >= limits.maxMessages) break
    if (trimmed.length > 0 && totalChars + len > limits.maxChars) break
    trimmed.push(msg)
    totalChars += len
  }
  return trimmed.reverse()
}

export function computeChatContextUsage(
  messages: ChatMessage[],
  limits: ChatHistoryLimits
): ChatContextUsage {
  const totalChars = messages.reduce((sum, msg) => sum + msg.content.length, 0)
  const percent = Math.min(100, Math.round((totalChars / limits.maxChars) * 100))
  return { totalChars, percent, totalMessages: messages.length }
}

export function hasUserChatMessage(messages: ChatMessage[]): boolean {
  return messages.some((msg) => msg.role === 'user' && msg.content.trim().length > 0)
}

export function buildChatRequestMessages(messages: ChatMessage[]) {
  return messages
    .filter((msg) => msg.content.length > 0)
    .map((msg) => ({ role: msg.role, content: msg.content }))
}
