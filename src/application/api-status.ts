import type { RunApiStatus } from "../shared/run-api-status.js";
import type { EnvState } from "./environment-state.js";

export function resolveRunApiStatus(envState: EnvState): RunApiStatus {
  return {
    apiKey: envState.apiKey,
    openrouterApiKey: envState.openrouterApiKey,
    openrouterConfigured: envState.openrouterConfigured,
    groqApiKey: envState.groqApiKey,
    assemblyaiApiKey: envState.assemblyaiApiKey,
    deepgramApiKey: envState.deepgramApiKey,
    elevenlabsApiKey: envState.elevenlabsApiKey,
    openaiApiKey: envState.openaiApiKey,
    xaiApiKey: envState.xaiApiKey,
    googleApiKey: envState.googleApiKey,
    anthropicApiKey: envState.anthropicApiKey,
    zaiApiKey: envState.zaiApiKey,
    zaiBaseUrl: envState.zaiBaseUrl,
    nvidiaApiKey: envState.nvidiaApiKey,
    nvidiaBaseUrl: envState.nvidiaBaseUrl,
    minimaxApiKey: envState.minimaxApiKey,
    minimaxBaseUrl: envState.minimaxBaseUrl,
    ollamaBaseUrl: envState.ollamaBaseUrl,
    firecrawlApiKey: envState.firecrawlApiKey,
    firecrawlConfigured: envState.firecrawlConfigured,
    googleConfigured: envState.googleConfigured,
    anthropicConfigured: envState.anthropicConfigured,
    apifyToken: envState.apifyToken,
    ytDlpPath: envState.ytDlpPath,
    ytDlpCookiesFromBrowser: envState.ytDlpCookiesFromBrowser,
    falApiKey: envState.falApiKey,
    providerBaseUrls: envState.providerBaseUrls,
  };
}
