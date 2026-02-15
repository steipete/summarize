import { isOpenRouterBaseUrl, resolveConfiguredBaseUrl } from "@steipete/summarize-core";
import type { CliProvider, SummarizeConfig } from "../config.js";
import { resolveCliAvailability, resolveExecutableInPath } from "./env.js";

export type VertexEnvConfig = {
  project: string;
  location: string;
};

export type EnvState = {
  apiKey: string | null;
  openrouterApiKey: string | null;
  openrouterConfigured: boolean;
  groqApiKey: string | null;
  openaiTranscriptionKey: string | null;
  xaiApiKey: string | null;
  googleApiKey: string | null;
  anthropicApiKey: string | null;
  zaiApiKey: string | null;
  zaiBaseUrl: string;
  nvidiaApiKey: string | null;
  nvidiaBaseUrl: string;
  firecrawlApiKey: string | null;
  firecrawlConfigured: boolean;
  googleConfigured: boolean;
  anthropicConfigured: boolean;
  vertexConfigured: boolean;
  vertexConfig: VertexEnvConfig | null;
  apifyToken: string | null;
  ytDlpPath: string | null;
  ytDlpCookiesFromBrowser: string | null;
  falApiKey: string | null;
  cliAvailability: Partial<Record<CliProvider, boolean>>;
  envForAuto: Record<string, string | undefined>;
  providerBaseUrls: {
    openai: string | null;
    nvidia: string | null;
    anthropic: string | null;
    google: string | null;
    xai: string | null;
  };
};

export function resolveEnvState({
  env,
  envForRun,
  configForCli,
}: {
  env: Record<string, string | undefined>;
  envForRun: Record<string, string | undefined>;
  configForCli: SummarizeConfig | null;
}): EnvState {
  const xaiKeyRaw = typeof envForRun.XAI_API_KEY === "string" ? envForRun.XAI_API_KEY : null;
  const openaiBaseUrl = resolveConfiguredBaseUrl({
    envValue: envForRun.OPENAI_BASE_URL,
    configValue: configForCli?.openai?.baseUrl,
  });
  const nvidiaBaseUrl = resolveConfiguredBaseUrl({
    envValue: envForRun.NVIDIA_BASE_URL,
    configValue: configForCli?.nvidia?.baseUrl,
  });
  const anthropicBaseUrl = resolveConfiguredBaseUrl({
    envValue: envForRun.ANTHROPIC_BASE_URL,
    configValue: configForCli?.anthropic?.baseUrl,
  });
  const googleBaseUrl = resolveConfiguredBaseUrl({
    envValue: envForRun.GOOGLE_BASE_URL ?? envForRun.GEMINI_BASE_URL,
    configValue: configForCli?.google?.baseUrl,
  });
  const xaiBaseUrl = resolveConfiguredBaseUrl({
    envValue: envForRun.XAI_BASE_URL,
    configValue: configForCli?.xai?.baseUrl,
  });
  const zaiKeyRaw =
    typeof envForRun.Z_AI_API_KEY === "string"
      ? envForRun.Z_AI_API_KEY
      : typeof envForRun.ZAI_API_KEY === "string"
        ? envForRun.ZAI_API_KEY
        : null;
  const zaiBaseUrlRaw =
    typeof envForRun.Z_AI_BASE_URL === "string"
      ? envForRun.Z_AI_BASE_URL
      : typeof envForRun.ZAI_BASE_URL === "string"
        ? envForRun.ZAI_BASE_URL
        : null;
  const openRouterKeyRaw =
    typeof envForRun.OPENROUTER_API_KEY === "string" ? envForRun.OPENROUTER_API_KEY : null;
  const openaiKeyRaw =
    typeof envForRun.OPENAI_API_KEY === "string" ? envForRun.OPENAI_API_KEY : null;
  const nvidiaKeyRaw =
    typeof envForRun.NVIDIA_API_KEY === "string"
      ? envForRun.NVIDIA_API_KEY
      : typeof envForRun.NGC_API_KEY === "string"
        ? envForRun.NGC_API_KEY
        : null;
  const apiKey =
    typeof openaiBaseUrl === "string" && isOpenRouterBaseUrl(openaiBaseUrl)
      ? (openRouterKeyRaw ?? openaiKeyRaw)
      : openaiKeyRaw;
  const apifyToken =
    typeof envForRun.APIFY_API_TOKEN === "string" ? envForRun.APIFY_API_TOKEN : null;
  const ytDlpPath = (() => {
    const explicit = typeof envForRun.YT_DLP_PATH === "string" ? envForRun.YT_DLP_PATH.trim() : "";
    if (explicit.length > 0) return explicit;
    return resolveExecutableInPath("yt-dlp", envForRun);
  })();
  const ytDlpCookiesFromBrowser = (() => {
    const raw =
      typeof envForRun.SUMMARIZE_YT_DLP_COOKIES_FROM_BROWSER === "string"
        ? envForRun.SUMMARIZE_YT_DLP_COOKIES_FROM_BROWSER
        : typeof envForRun.YT_DLP_COOKIES_FROM_BROWSER === "string"
          ? envForRun.YT_DLP_COOKIES_FROM_BROWSER
          : "";
    const value = raw.trim();
    return value.length > 0 ? value : null;
  })();
  const groqApiKey =
    typeof envForRun.GROQ_API_KEY === "string" ? envForRun.GROQ_API_KEY.trim() || null : null;
  const falApiKey = typeof envForRun.FAL_KEY === "string" ? envForRun.FAL_KEY : null;
  const firecrawlKey =
    typeof envForRun.FIRECRAWL_API_KEY === "string" ? envForRun.FIRECRAWL_API_KEY : null;
  const anthropicKeyRaw =
    typeof envForRun.ANTHROPIC_API_KEY === "string" ? envForRun.ANTHROPIC_API_KEY : null;
  const googleKeyRaw =
    typeof envForRun.GEMINI_API_KEY === "string"
      ? envForRun.GEMINI_API_KEY
      : typeof envForRun.GOOGLE_GENERATIVE_AI_API_KEY === "string"
        ? envForRun.GOOGLE_GENERATIVE_AI_API_KEY
        : typeof envForRun.GOOGLE_API_KEY === "string"
          ? envForRun.GOOGLE_API_KEY
          : null;

  const firecrawlApiKey = firecrawlKey && firecrawlKey.trim().length > 0 ? firecrawlKey : null;
  const firecrawlConfigured = firecrawlApiKey !== null;
  const xaiApiKey = xaiKeyRaw?.trim() ?? null;
  const zaiApiKey = zaiKeyRaw?.trim() ?? null;
  const zaiBaseUrl = (zaiBaseUrlRaw?.trim() ?? "") || "https://api.z.ai/api/paas/v4";
  const nvidiaApiKey = nvidiaKeyRaw?.trim() ?? null;
  const nvidiaBaseUrlEffective =
    (nvidiaBaseUrl?.trim() ?? "") || "https://integrate.api.nvidia.com/v1";
  const googleApiKey = googleKeyRaw?.trim() ?? null;
  const anthropicApiKey = anthropicKeyRaw?.trim() ?? null;
  const openrouterApiKey = (() => {
    const explicit = openRouterKeyRaw?.trim() ?? "";
    if (explicit.length > 0) return explicit;
    const baseUrl = openaiBaseUrl ?? "";
    const openaiKey = openaiKeyRaw?.trim() ?? "";
    if (baseUrl.length > 0 && isOpenRouterBaseUrl(baseUrl) && openaiKey.length > 0) {
      return openaiKey;
    }
    return null;
  })();
  const openaiTranscriptionKey = openaiKeyRaw?.trim() ?? null;
  const googleConfigured = typeof googleApiKey === "string" && googleApiKey.length > 0;
  const anthropicConfigured = typeof anthropicApiKey === "string" && anthropicApiKey.length > 0;

  // Vertex AI: requires project + location + some form of credentials (service account, ADC, or GCE metadata)
  const vertexProject =
    typeof envForRun.GOOGLE_CLOUD_PROJECT === "string"
      ? envForRun.GOOGLE_CLOUD_PROJECT.trim()
      : typeof envForRun.GCLOUD_PROJECT === "string"
        ? envForRun.GCLOUD_PROJECT.trim()
        : typeof envForRun.VERTEX_AI_PROJECT_ID === "string"
          ? envForRun.VERTEX_AI_PROJECT_ID.trim()
          : "";
  const vertexLocation =
    typeof envForRun.GOOGLE_CLOUD_LOCATION === "string"
      ? envForRun.GOOGLE_CLOUD_LOCATION.trim()
      : typeof envForRun.VERTEX_AI_LOCATION === "string"
        ? envForRun.VERTEX_AI_LOCATION.trim()
        : "";
  const hasVertexCredentials =
    typeof envForRun.VERTEX_AI_SERVICE_ACCOUNT_KEY === "string" ||
    typeof envForRun.GOOGLE_SERVICE_ACCOUNT_KEY === "string" ||
    typeof envForRun.GOOGLE_APPLICATION_CREDENTIALS === "string";
  const vertexConfigured =
    vertexProject.length > 0 && vertexLocation.length > 0 && hasVertexCredentials;
  const vertexConfig: VertexEnvConfig | null = vertexConfigured
    ? { project: vertexProject, location: vertexLocation }
    : null;
  const openrouterConfigured = typeof openrouterApiKey === "string" && openrouterApiKey.length > 0;
  const cliAvailability = resolveCliAvailability({ env, config: configForCli });
  const envForAuto = openrouterApiKey ? { ...env, OPENROUTER_API_KEY: openrouterApiKey } : env;
  const providerBaseUrls = {
    openai: openaiBaseUrl,
    nvidia: nvidiaBaseUrl,
    anthropic: anthropicBaseUrl,
    google: googleBaseUrl,
    xai: xaiBaseUrl,
  };

  return {
    apiKey: apiKey?.trim() ?? null,
    openrouterApiKey,
    openrouterConfigured,
    groqApiKey,
    openaiTranscriptionKey,
    xaiApiKey,
    googleApiKey,
    anthropicApiKey,
    zaiApiKey,
    zaiBaseUrl,
    nvidiaApiKey,
    nvidiaBaseUrl: nvidiaBaseUrlEffective,
    firecrawlApiKey,
    firecrawlConfigured,
    googleConfigured,
    anthropicConfigured,
    vertexConfigured,
    vertexConfig,
    apifyToken,
    ytDlpPath,
    ytDlpCookiesFromBrowser,
    falApiKey,
    cliAvailability,
    envForAuto,
    providerBaseUrls,
  };
}
