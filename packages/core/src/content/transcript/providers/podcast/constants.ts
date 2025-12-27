export const FEED_HINT_URL_PATTERN = /rss|feed|podcast|\.xml($|[?#])/i
export const PODCAST_PLATFORM_HOST_PATTERN =
  /open\.spotify\.com|spotify\.com|podcasts\.apple\.com|overcast\.fm|pca\.st|pod\.link|castbox\.fm|player\.fm/i
export const TRANSCRIPTION_TIMEOUT_MS = 600_000
export const MAX_REMOTE_MEDIA_BYTES = 512 * 1024 * 1024
export const BLOCKED_HTML_HINT_PATTERN =
  /access denied|attention required|captcha|recaptcha|cloudflare|forbidden|verify you are human/i
export const ITUNES_SEARCH_URL = 'https://itunes.apple.com/search'
export const ITUNES_LOOKUP_URL = 'https://itunes.apple.com/lookup'
