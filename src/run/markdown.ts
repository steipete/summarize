function materializeInlineMarkdownLinks(markdown: string): string {
  // markdansi renders Markdown links as styled labels, which makes URLs non-clickable in many terminals.
  // Convert links into `Label (https://...)` so the raw URL is visible.
  const lines = markdown.split(/\r?\n/)
  let inFence = false
  const out: string[] = []
  for (const line of lines) {
    const trimmed = line.trimStart()
    if (trimmed.startsWith('```')) {
      inFence = !inFence
      out.push(line)
      continue
    }
    if (inFence) {
      out.push(line)
      continue
    }
    out.push(
      line.replace(/(?<!!)\[([^\]]+)\]\((\S+?)\)/g, (_full, label, url) => {
        const safeLabel = String(label ?? '').trim()
        const safeUrl = String(url ?? '').trim()
        if (!safeLabel || !safeUrl) return _full
        // Keep the raw URL visible and terminal-linkable (avoid trailing ')' issues).
        return `${safeLabel}: ${safeUrl}`
      })
    )
  }
  return out.join('\n')
}

function collapseExtraBlankLines(markdown: string): string {
  const lines = markdown.split(/\r?\n/)
  let inFence = false
  let blankRun = 0
  const out: string[] = []

  for (const line of lines) {
    const trimmed = line.trimStart()
    if (trimmed.startsWith('```')) {
      inFence = !inFence
      blankRun = 0
      out.push(line)
      continue
    }
    if (inFence) {
      blankRun = 0
      out.push(line)
      continue
    }

    if (line.trim().length === 0) {
      blankRun += 1
      if (blankRun === 1) out.push('')
      continue
    }

    blankRun = 0
    out.push(line)
  }

  return out.join('\n')
}

export function prepareMarkdownLineForTerminal(line: string): string {
  return line.replace(/(?<!!)\[([^\]]+)\]\((\S+?)\)/g, (_full, label, url) => {
    const safeLabel = String(label ?? '').trim()
    const safeUrl = String(url ?? '').trim()
    if (!safeLabel || !safeUrl) return _full
    return `${safeLabel}: ${safeUrl}`
  })
}

export function prepareMarkdownForTerminalStreaming(markdown: string): string {
  // Streaming is append-only; never rewrite earlier content (e.g. reference-style links).
  // Only apply local, fence-aware transformations.
  return collapseExtraBlankLines(materializeInlineMarkdownLinks(markdown))
}

function inlineReferenceStyleLinks(markdown: string): string {
  // Some models like emitting reference-style links:
  //   [Label][1]
  //   [1]: https://example.com
  // Many terminals won't auto-link the label, so we inline them to keep links clickable.
  const lines = markdown.split(/\r?\n/)
  const definitions = new Map<string, string>()
  for (const line of lines) {
    const match = line.match(/^\s*\[([^\]]+)\]:\s*(\S+)\s*$/)
    if (!match?.[1] || !match[2]) continue
    definitions.set(match[1].trim().toLowerCase(), match[2].trim())
  }
  if (definitions.size === 0) return markdown

  const used = new Set<string>()
  const inlined = markdown.replace(/\[([^\]]+)\]\[([^\]]*)\]/g, (full, rawLabel, rawRef) => {
    const label = String(rawLabel ?? '').trim()
    const ref = String(rawRef ?? '').trim()
    const key = (ref || label).toLowerCase()
    const url = definitions.get(key)
    if (!url) return full
    used.add(key)
    return `[${label}](${url})`
  })

  if (used.size === 0) return inlined
  const withoutDefinitions = inlined
    .split(/\r?\n/)
    .filter((line) => {
      const match = line.match(/^\s*\[([^\]]+)\]:\s*(\S+)\s*$/)
      if (!match?.[1]) return true
      return !used.has(match[1].trim().toLowerCase())
    })
    .join('\n')
  return withoutDefinitions
}

export function prepareMarkdownForTerminal(markdown: string): string {
  return collapseExtraBlankLines(
    materializeInlineMarkdownLinks(inlineReferenceStyleLinks(markdown))
  )
}
