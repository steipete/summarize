type Env = Record<string, string | undefined>;

/**
 * Normalize a base URL string, trimming whitespace and returning null for empty values.
 */
function normalizeBaseUrl(raw: string | null | undefined): string | null {
  const trimmed = typeof raw === "string" ? raw.trim() : "";
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Resolve the Groq API base URL for transcription.
 *
 * Resolution order (highest to lowest priority):
 * 1. explicitBaseUrl parameter
 * 2. GROQ_BASE_URL environment variable
 * 3. Default Groq API URL
 *
 * @param options - Configuration options
 * @returns The resolved base URL (with trailing slash for path concatenation)
 */
export function resolveGroqBaseUrl({
  explicitBaseUrl,
  env,
  defaultBaseUrl = "https://api.groq.com/openai/v1",
}: {
  explicitBaseUrl?: string | null;
  env?: Env;
  defaultBaseUrl?: string;
}): string {
  const explicit = normalizeBaseUrl(explicitBaseUrl);
  if (explicit) {
    // Remove trailing slash for consistent handling
    return explicit.endsWith("/") ? explicit.slice(0, -1) : explicit;
  }

  const effectiveEnv = env ?? process.env;
  const groqBaseUrl = normalizeBaseUrl(effectiveEnv.GROQ_BASE_URL);
  if (groqBaseUrl) {
    return groqBaseUrl.endsWith("/") ? groqBaseUrl.slice(0, -1) : groqBaseUrl;
  }

  return defaultBaseUrl;
}

/**
 * Build the full Groq transcription API endpoint URL.
 *
 * @param baseUrl - The base URL (from resolveGroqBaseUrl)
 * @param path - The API path (default: "/audio/transcriptions")
 * @returns The full URL for the Groq API endpoint
 */
export function buildGroqApiUrl(
  baseUrl: string,
  path = "/audio/transcriptions"
): string {
  const normalizedBaseUrl = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  return `${normalizedBaseUrl}${path.startsWith("/") ? path.slice(1) : path}`;
}
