import { resolveGoogleModelForUsage } from "../llm/google-models.js";
import type { parseGatewayStyleModelId } from "../llm/model-id.js";

const GOOGLE_DEVELOPER_API_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";

function isCustomGoogleBaseUrl(raw: string | null | undefined): boolean {
  const normalized = raw?.trim().replace(/\/+$/, "");
  return Boolean(normalized && normalized !== GOOGLE_DEVELOPER_API_BASE_URL);
}

export async function resolveModelIdForLlmCall({
  parsedModel,
  apiKeys,
  googleBaseUrlOverride,
  fetchImpl,
  timeoutMs,
}: {
  parsedModel: ReturnType<typeof parseGatewayStyleModelId>;
  apiKeys: {
    googleApiKey: string | null;
  };
  googleBaseUrlOverride?: string | null;
  fetchImpl: typeof fetch;
  timeoutMs: number;
}): Promise<{ modelId: string; note: string | null }> {
  const key = apiKeys.googleApiKey;
  if (parsedModel.provider !== "google" || !key || isCustomGoogleBaseUrl(googleBaseUrlOverride)) {
    return { modelId: parsedModel.canonical, note: null };
  }

  const resolved = await resolveGoogleModelForUsage({
    requestedModelId: parsedModel.model,
    apiKey: key,
    fetchImpl,
    timeoutMs,
  });

  return {
    modelId: `google/${resolved.resolvedModelId}`,
    note: resolved.note,
  };
}
