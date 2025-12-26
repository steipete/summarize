const PODCAST_HOST_SUFFIXES = [
  'spotify.com',
  'podcasts.apple.com',
  'podchaser.com',
  'podbean.com',
  'buzzsprout.com',
  'spreaker.com',
  'simplecast.com',
  'rss.com',
  'libsyn.com',
  'omny.fm',
  'acast.com',
  'transistor.fm',
  'captivate.fm',
  'soundcloud.com',
  'ivoox.com',
  'iheart.com',
  'megaphone.fm',
  'pca.st',
  'player.fm',
  'castbox.fm',
]

export function extractSpotifyEpisodeId(url: string): string | null {
  try {
    const parsed = new URL(url)
    const host = parsed.hostname.toLowerCase().replace(/^www\./, '')
    if (!host.endsWith('spotify.com')) return null
    const parts = parsed.pathname.split('/').filter(Boolean)
    const idx = parts.indexOf('episode')
    const id = idx >= 0 ? parts[idx + 1] : null
    return id && /^[A-Za-z0-9]+$/.test(id) ? id : null
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

export function isPodcastLikeJsonLdType(type: string | null | undefined): boolean {
  if (!type) return false
  const normalized = type.toLowerCase()
  if (normalized.includes('podcast')) return true
  return (
    normalized === 'audioobject' ||
    normalized === 'episode' ||
    normalized === 'radioepisode' ||
    normalized === 'musicrecording'
  )
}

export function isPodcastHost(url: string): boolean {
  try {
    const parsed = new URL(url)
    const host = parsed.hostname.toLowerCase().replace(/^www\./, '')
    if (host.startsWith('music.amazon.') && parsed.pathname.includes('/podcasts/')) {
      return true
    }
    return PODCAST_HOST_SUFFIXES.some((suffix) => host === suffix || host.endsWith(`.${suffix}`))
  } catch {
    return false
  }
}
