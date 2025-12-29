import type MarkdownIt from 'markdown-it'

import {
  buildChatRequestMessages,
  computeChatContextUsage,
  hasUserChatMessage,
  type ChatHistoryLimits,
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
}

export class ChatController {
  private messages: ChatMessage[] = []
  private readonly messagesEl: HTMLDivElement
  private readonly inputEl: HTMLTextAreaElement
  private readonly sendBtn: HTMLButtonElement
  private readonly contextEl: HTMLDivElement
  private readonly markdown: MarkdownIt
  private readonly limits: ChatHistoryLimits

  constructor(opts: ChatControllerOptions) {
    this.messagesEl = opts.messagesEl
    this.inputEl = opts.inputEl
    this.sendBtn = opts.sendBtn
    this.contextEl = opts.contextEl
    this.markdown = opts.markdown
    this.limits = opts.limits
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
      this.messagesEl.scrollTop = this.messagesEl.scrollHeight
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

  updateStreamingMessage(content: string) {
    const lastMsg = this.messages[this.messages.length - 1]
    if (lastMsg?.role === 'assistant') {
      lastMsg.content = content
      const msgEl = this.messagesEl.querySelector(`[data-id="${lastMsg.id}"]`)
      if (msgEl) {
        msgEl.innerHTML = this.markdown.render(content || '...')
        msgEl.classList.add('streaming')
        for (const a of Array.from(msgEl.querySelectorAll('a'))) {
          a.setAttribute('target', '_blank')
          a.setAttribute('rel', 'noopener noreferrer')
        }
        this.messagesEl.scrollTop = this.messagesEl.scrollHeight
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
      }
    }
    this.updateContextStatus()
  }

  private renderMessage(message: ChatMessage, opts?: RenderOptions) {
    const msgEl = document.createElement('div')
    msgEl.className = `chatMessage ${message.role}`
    msgEl.dataset.id = message.id

    if (message.role === 'assistant') {
      msgEl.innerHTML = this.markdown.render(message.content || '...')
      for (const a of Array.from(msgEl.querySelectorAll('a'))) {
        a.setAttribute('target', '_blank')
        a.setAttribute('rel', 'noopener noreferrer')
      }
    } else {
      msgEl.textContent = message.content
    }

    if (opts?.prepend) {
      this.messagesEl.prepend(msgEl)
    } else {
      this.messagesEl.appendChild(msgEl)
    }

    if (opts?.scroll !== false) {
      this.messagesEl.scrollTop = this.messagesEl.scrollHeight
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
}
