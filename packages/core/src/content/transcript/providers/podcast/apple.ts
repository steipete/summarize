export function extractAppleEpisodeTitleFromHtml(html: string): string | null {
  // Apple Podcast episode pages include `apple:title` and `og:title` meta tags.
  // Prefer `apple:title` (episode title only) to match RSS items.
  const apple =
    html.match(/<meta\s+name=["']apple:title["']\s+content=["']([^"']+)["']/i)?.[1] ?? null
  const og =
    html.match(/<meta\s+property=["']og:title["']\s+content=["']([^"']+)["']/i)?.[1] ?? null
  const title = (apple ?? og ?? '').trim()
  return title.length > 0 ? title : null
}

export function extractEmbeddedJsonUrl(html: string, field: string): string | null {
  const pattern = new RegExp(`"${field}":"((?:\\\\.|[^"\\\\])*)"`, 'i')
  const match = html.match(pattern)
  if (!match?.[1]) return null
  try {
    return JSON.parse(`"${match[1]}"`) as string
  } catch {
    return null
  }
}

export function extractApplePodcastIds(
  url: string
): { showId: string; episodeId: string | null } | null {
  try {
    const parsed = new URL(url)
    const host = parsed.hostname.toLowerCase().replace(/^www\./, '')
    if (host !== 'podcasts.apple.com') return null
    const showId = parsed.pathname.match(/\/id(\d+)(?:\/|$)/)?.[1] ?? null
    if (!showId) return null
    const episodeIdRaw = parsed.searchParams.get('i')
    const episodeId = episodeIdRaw && /^\d+$/.test(episodeIdRaw) ? episodeIdRaw : null
    return { showId, episodeId }
  } catch {
    return null
  }
}
