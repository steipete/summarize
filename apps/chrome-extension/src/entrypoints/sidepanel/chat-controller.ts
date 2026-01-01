import type MarkdownIt from 'markdown-it'

import {
  buildChatRequestMessages,
  type ChatHistoryLimits,
  computeChatContextUsage,
  hasUserChatMessage,
} from './chat-state'
import type { ChatMessage } from './types'

type RenderOptions = { prepend?: boolean; scroll?: boolean }

export type ChatControllerOptions = {
  messagesEl: HTMLDivElement
  inputEl: HTMLTextAreaElement
  sendBtn: HTMLButtonElement
  contextEl: HTMLDivElement
  markdown: MarkdownIt
  limits: ChatHistoryLimits
  scrollToBottom?: () => void
  onNewContent?: () => void
}

export class ChatController {
  private messages: ChatMessage[] = []
  private readonly messagesEl: HTMLDivElement
  private readonly inputEl: HTMLTextAreaElement
  private readonly sendBtn: HTMLButtonElement
  private readonly contextEl: HTMLDivElement
  private readonly markdown: MarkdownIt
  private readonly limits: ChatHistoryLimits
  private readonly scrollToBottom?: () => void
  private readonly onNewContent?: () => void
  private readonly typingIndicatorHtml =
    '<span class="chatTyping" aria-label="Typing"><span></span><span></span><span></span></span>'

  private readonly timestampPattern = /\[(\d{1,2}:\d{2}(?::\d{2})?)\]/g

  constructor(opts: ChatControllerOptions) {
    this.messagesEl = opts.messagesEl
    this.inputEl = opts.inputEl
    this.sendBtn = opts.sendBtn
    this.contextEl = opts.contextEl
    this.markdown = opts.markdown
    this.limits = opts.limits
    this.scrollToBottom = opts.scrollToBottom
    this.onNewContent = opts.onNewContent
  }

  getMessages(): ChatMessage[] {
    return this.messages
  }

  hasUserMessages(): boolean {
    return hasUserChatMessage(this.messages)
  }

  buildRequestMessages() {
    return buildChatRequestMessages(this.messages)
  }

  reset() {
    this.messages = []
    this.messagesEl.innerHTML = ''
    this.inputEl.value = ''
    this.sendBtn.disabled = false
    this.updateVisibility()
    this.updateContextStatus()
  }

  setMessages(messages: ChatMessage[], opts?: RenderOptions) {
    this.messages = messages
    this.messagesEl.innerHTML = ''
    for (const message of messages) {
      this.renderMessage(message, { scroll: false })
    }
    if (opts?.scroll !== false) {
      this.onNewContent?.()
      this.scrollToBottom?.()
    }
    this.updateVisibility()
    this.updateContextStatus()
  }

  addMessage(message: ChatMessage, opts?: RenderOptions) {
    this.messages.push(message)
    this.renderMessage(message, opts)
    this.updateVisibility()
    this.updateContextStatus()
  }

  replaceMessage(message: ChatMessage, opts?: RenderOptions) {
    const index = this.messages.findIndex((item) => item.id === message.id)
    if (index === -1) {
      this.addMessage(message, opts)
      return
    }
    this.messages[index] = message
    const existing = this.messagesEl.querySelector(`[data-id="${message.id}"]`)
    if (existing) {
      const nextEl = this.createMessageElement(message)
      existing.replaceWith(nextEl)
    } else {
      this.renderMessage(message, opts)
    }
    if (opts?.scroll !== false) {
      this.onNewContent?.()
      this.scrollToBottom?.()
    }
    this.updateVisibility()
    this.updateContextStatus()
  }

  updateStreamingMessage(content: string) {
    const lastMsg = this.messages[this.messages.length - 1]
    if (lastMsg?.role === 'assistant') {
      lastMsg.content = [{ type: 'text', text: content }]
      const msgEl = this.messagesEl.querySelector(`[data-id="${lastMsg.id}"]`)
      if (msgEl) {
        if (content.trim()) {
          msgEl.innerHTML = this.markdown.render(this.linkifyTimestamps(content))
          msgEl.removeAttribute('data-placeholder')
        } else {
          msgEl.innerHTML = this.typingIndicatorHtml
          msgEl.setAttribute('data-placeholder', 'true')
        }
        msgEl.classList.add('streaming')
        this.decorateAnchors(msgEl)
        this.onNewContent?.()
        this.scrollToBottom?.()
      }
    }
    this.updateContextStatus()
  }

  finishStreamingMessage() {
    const lastMsg = this.messages[this.messages.length - 1]
    if (lastMsg?.role === 'assistant') {
      const msgEl = this.messagesEl.querySelector(`[data-id="${lastMsg.id}"]`)
      if (msgEl) {
        msgEl.classList.remove('streaming')
        msgEl.removeAttribute('data-placeholder')
      }
    }
    this.updateContextStatus()
  }

  private renderMessage(message: ChatMessage, opts?: RenderOptions) {
    const msgEl = this.createMessageElement(message)
    if (opts?.prepend) {
      this.messagesEl.prepend(msgEl)
    } else {
      this.messagesEl.appendChild(msgEl)
    }

    if (opts?.scroll !== false) {
      this.onNewContent?.()
      this.scrollToBottom?.()
    }
  }

  private updateVisibility() {
    const hasMessages = this.messages.length > 0
    this.messagesEl.classList.toggle('isHidden', !hasMessages)
  }

  private updateContextStatus() {
    if (!this.hasUserMessages()) {
      this.contextEl.textContent = ''
      this.contextEl.removeAttribute('data-state')
      this.contextEl.classList.add('isHidden')
      return
    }
    const usage = computeChatContextUsage(this.messages, this.limits)
    this.contextEl.classList.remove('isHidden')
    this.contextEl.textContent = `Context ${usage.percent}% · ${usage.totalMessages} msgs · ${usage.totalChars.toLocaleString()} chars`
    if (usage.percent >= 85) {
      this.contextEl.dataset.state = 'warn'
    } else {
      this.contextEl.removeAttribute('data-state')
    }
  }

  private linkifyTimestamps(content: string): string {
    return content.replace(this.timestampPattern, (match, time) => {
      const seconds = parseTimestampSeconds(time)
      if (seconds == null) return match
      return `[${time}](timestamp:${seconds})`
    })
  }

  private createMessageElement(message: ChatMessage): HTMLDivElement {
    const msgEl = document.createElement('div')
    msgEl.className = `chatMessage ${message.role}`
    msgEl.dataset.id = message.id

    if (message.role === 'assistant') {
      const { text, toolCalls } = splitAssistantMessage(message)
      const rendered = buildAssistantMarkdown(text, toolCalls)
      if (rendered.trim()) {
        msgEl.innerHTML = this.markdown.render(this.linkifyTimestamps(rendered))
      } else {
        msgEl.innerHTML = this.typingIndicatorHtml
        msgEl.classList.add('streaming')
        msgEl.setAttribute('data-placeholder', 'true')
      }
      this.decorateAnchors(msgEl)
    } else if (message.role === 'toolResult') {
      msgEl.classList.add('tool')
      if (message.isError) msgEl.classList.add('error')
      const output = extractText(message)
      const header = `Tool result: ${message.toolName}${message.isError ? ' (error)' : ''}`
      const body = output ? `\n\n\`\`\`\n${output}\n\`\`\`` : ''
      msgEl.innerHTML = this.markdown.render(`${header}${body}`)
      const attachments = extractAttachments(message)
      if (attachments.length > 0) {
        const list = document.createElement('div')
        list.className = 'chatAttachments'
        for (const file of attachments) {
          const link = document.createElement('button')
          link.type = 'button'
          link.className = 'chatAttachment'
          link.textContent = `${file.fileName} (${file.mimeType || 'file'})`
          link.addEventListener('click', () => {
            const blob = base64ToBlob(file.contentBase64, file.mimeType)
            const url = URL.createObjectURL(blob)
            const anchor = document.createElement('a')
            anchor.href = url
            anchor.download = file.fileName || 'download'
            anchor.click()
            setTimeout(() => URL.revokeObjectURL(url), 1000)
          })
          list.appendChild(link)
        }
        msgEl.appendChild(list)
      }
    } else {
      msgEl.textContent = extractText(message)
    }

    return msgEl
  }

  private decorateAnchors(root: HTMLElement) {
    for (const a of Array.from(root.querySelectorAll('a'))) {
      const href = a.getAttribute('href') ?? ''
      if (href.startsWith('timestamp:')) {
        a.classList.add('chatTimestamp')
        a.removeAttribute('target')
        a.removeAttribute('rel')
        continue
      }
      a.setAttribute('target', '_blank')
      a.setAttribute('rel', 'noopener noreferrer')
    }
  }
}

function extractText(message: ChatMessage): string {
  if (message.role === 'user') {
    if (typeof message.content === 'string') return message.content
    return message.content
      .filter((part) => part.type === 'text')
      .map((part) => part.text)
      .join('')
  }
  if (message.role === 'assistant') {
    return message.content
      .filter((part) => part.type === 'text')
      .map((part) => part.text)
      .join('')
  }
  if (message.role === 'toolResult') {
    return message.content
      .filter((part) => part.type === 'text')
      .map((part) => part.text)
      .join('')
  }
  return ''
}

type ToolAttachment = { fileName: string; mimeType: string; contentBase64: string }

function extractAttachments(message: ChatMessage): ToolAttachment[] {
  if (message.role !== 'toolResult') return []
  const details = (message as ChatMessage & { details?: unknown }).details
  if (!details || typeof details !== 'object') return []
  const files = (details as { files?: unknown }).files
  if (!Array.isArray(files)) return []
  return files
    .map((file) => {
      if (!file || typeof file !== 'object') return null
      const item = file as Record<string, unknown>
      const fileName = typeof item.fileName === 'string' ? item.fileName : ''
      const mimeType =
        typeof item.mimeType === 'string' ? item.mimeType : 'application/octet-stream'
      const contentBase64 = typeof item.contentBase64 === 'string' ? item.contentBase64 : ''
      if (!fileName || !contentBase64) return null
      return { fileName, mimeType, contentBase64 }
    })
    .filter((file): file is ToolAttachment => Boolean(file))
}

function base64ToBlob(base64: string, mimeType: string): Blob {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i)
  }
  return new Blob([bytes], { type: mimeType || 'application/octet-stream' })
}

function splitAssistantMessage(message: ChatMessage): {
  text: string
  toolCalls: Array<{ name: string; arguments: Record<string, unknown> }>
} {
  const text = message.content
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('')
  const toolCalls = message.content
    .filter((part) => part.type === 'toolCall')
    .map((call) => ({ name: call.name, arguments: call.arguments }))
  return { text, toolCalls }
}

function buildAssistantMarkdown(
  text: string,
  toolCalls: Array<{ name: string; arguments: Record<string, unknown> }>
): string {
  if (!toolCalls.length) return text
  const calls = toolCalls
    .map(
      (call) =>
        `**Tool:** ${call.name}\n\n\`\`\`json\n${JSON.stringify(call.arguments, null, 2)}\n\`\`\``
    )
    .join('\n\n')
  if (!text.trim()) return calls
  return `${text}\n\n---\n\n${calls}`
}

function parseTimestampSeconds(value: string): number | null {
  const parts = value.split(':').map((part) => part.trim())
  if (parts.length < 2 || parts.length > 3) return null
  const secondsPart = parts.pop()
  if (!secondsPart) return null
  const seconds = Number(secondsPart)
  if (!Number.isFinite(seconds) || seconds < 0) return null
  const minutesPart = parts.pop()
  if (minutesPart == null) return null
  const minutes = Number(minutesPart)
  if (!Number.isFinite(minutes) || minutes < 0) return null
  const hoursPart = parts.pop()
  const hours = hoursPart != null ? Number(hoursPart) : 0
  if (!Number.isFinite(hours) || hours < 0) return null
  return Math.floor(hours * 3600 + minutes * 60 + seconds)
}
