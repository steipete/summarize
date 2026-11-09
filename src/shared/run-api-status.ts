export type RunApiStatus = {
  apiKey: string | null;
  openrouterApiKey: string | null;
  openrouterConfigured: boolean;
  groqApiKey: string | null;
  assemblyaiApiKey: string | null;
  deepgramApiKey: string | null;
  elevenlabsApiKey: string | null;
  openaiApiKey: string | null;
  xaiApiKey: string | null;
  googleApiKey: string | null;
  anthropicApiKey: string | null;
  zaiApiKey: string | null;
  zaiBaseUrl: string;
  nvidiaApiKey: string | null;
  nvidiaBaseUrl: string;
  minimaxApiKey: string | null;
  minimaxBaseUrl: string;
  ollamaBaseUrl: string;
  firecrawlApiKey: string | null;
  firecrawlConfigured: boolean;
  googleConfigured: boolean;
  anthropicConfigured: boolean;
  apifyToken: string | null;
  ytDlpPath: string | null;
  ytDlpCookiesFromBrowser: string | null;
  falApiKey: string | null;
  providerBaseUrls: {
    openai: string | null;
    nvidia: string | null;
    anthropic: string | null;
    google: string | null;
    xai: string | null;
  };
};

export type RunApiAvailability = Pick<
  RunApiStatus,
  | "xaiApiKey"
  | "apiKey"
  | "openrouterApiKey"
  | "apifyToken"
  | "firecrawlConfigured"
  | "googleConfigured"
  | "anthropicConfigured"
>;

export function buildRunJsonEnv(apiStatus: RunApiAvailability) {
  return {
    hasXaiKey: Boolean(apiStatus.xaiApiKey),
    hasOpenAIKey: Boolean(apiStatus.apiKey),
    hasOpenRouterKey: Boolean(apiStatus.openrouterApiKey),
    hasApifyToken: Boolean(apiStatus.apifyToken),
    hasFirecrawlKey: apiStatus.firecrawlConfigured,
    hasGoogleKey: apiStatus.googleConfigured,
    hasAnthropicKey: apiStatus.anthropicConfigured,
  };
}
