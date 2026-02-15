import type { Context } from "@mariozechner/pi-ai";
import { completeSimple } from "@mariozechner/pi-ai";
import type { Attachment } from "../attachments.js";
import type { LlmTokenUsage } from "../types.js";
import { normalizeGoogleUsage, normalizeTokenUsage } from "../usage.js";
import { resolveVertexModel } from "./models.js";
import { bytesToBase64 } from "./shared.js";

export type VertexConfig = {
  project: string;
  location: string;
};

export async function completeVertexText({
  modelId,
  vertexConfig,
  context,
  temperature,
  maxOutputTokens,
  signal,
}: {
  modelId: string;
  vertexConfig: VertexConfig;
  context: Context;
  temperature?: number;
  maxOutputTokens?: number;
  signal: AbortSignal;
}): Promise<{ text: string; usage: LlmTokenUsage | null }> {
  const model = resolveVertexModel({ modelId, context });
  const result = await completeSimple(model, context, {
    ...(typeof temperature === "number" ? { temperature } : {}),
    ...(typeof maxOutputTokens === "number" ? { maxTokens: maxOutputTokens } : {}),
    project: vertexConfig.project,
    location: vertexConfig.location,
    signal,
  } as Record<string, unknown>);
  const text = result.content
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("")
    .trim();
  if (!text) throw new Error(`LLM returned an empty summary (model vertex/${modelId}).`);
  return { text, usage: normalizeTokenUsage(result.usage) };
}

export async function completeVertexDocument({
  modelId,
  vertexConfig,
  promptText,
  document,
  maxOutputTokens,
  temperature,
  timeoutMs,
  fetchImpl,
}: {
  modelId: string;
  vertexConfig: VertexConfig;
  promptText: string;
  document: Attachment;
  maxOutputTokens?: number;
  temperature?: number;
  timeoutMs: number;
  fetchImpl: typeof fetch;
}): Promise<{ text: string; usage: LlmTokenUsage | null }> {
  if (document.kind !== "document") {
    throw new Error("Internal error: expected a document attachment for Vertex.");
  }

  // Use the Vertex AI REST endpoint directly for document attachments.
  // Auth is handled via Application Default Credentials (ADC).
  const baseUrl = `https://${vertexConfig.location}-aiplatform.googleapis.com/v1/projects/${vertexConfig.project}/locations/${vertexConfig.location}/publishers/google/models`;
  const url = `${baseUrl}/${modelId}:generateContent`;

  // Get access token from ADC via the metadata server or gcloud
  const accessToken = await resolveAccessToken();

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const payload = {
    contents: [
      {
        parts: [
          {
            inline_data: {
              mime_type: document.mediaType,
              data: bytesToBase64(document.bytes),
            },
          },
          { text: promptText },
        ],
      },
    ],
    ...(typeof maxOutputTokens === "number"
      ? { generationConfig: { maxOutputTokens } }
      : {}),
    ...(typeof temperature === "number"
      ? { generationConfig: { ...(typeof maxOutputTokens === "number" ? { maxOutputTokens } : {}), temperature } }
      : {}),
  };

  try {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    const bodyText = await response.text();
    if (!response.ok) {
      const error = new Error(`Vertex AI API error (${response.status}).`);
      (error as { statusCode?: number }).statusCode = response.status;
      (error as { responseBody?: string }).responseBody = bodyText;
      throw error;
    }

    const data = JSON.parse(bodyText) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
      usageMetadata?: unknown;
    };
    const text = (data.candidates ?? [])
      .flatMap((candidate) => candidate.content?.parts ?? [])
      .map((part) => (typeof part.text === "string" ? part.text : ""))
      .join("")
      .trim();
    if (!text) {
      throw new Error(`LLM returned an empty summary (model vertex/${modelId}).`);
    }
    return { text, usage: normalizeGoogleUsage(data.usageMetadata) };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Resolve an OAuth2 access token via Application Default Credentials.
 *
 * Priority:
 * 1. GOOGLE_APPLICATION_CREDENTIALS / VERTEX_AI_SERVICE_ACCOUNT_KEY (service account JSON)
 * 2. GCE metadata server (when running on GCP)
 * 3. gcloud auth print-access-token (local dev)
 */
async function resolveAccessToken(): Promise<string> {
  // 1. Try service account JSON from env
  const saKeyRaw =
    process.env.VERTEX_AI_SERVICE_ACCOUNT_KEY ??
    process.env.GOOGLE_SERVICE_ACCOUNT_KEY ??
    null;

  if (saKeyRaw) {
    return await getAccessTokenFromServiceAccountJson(saKeyRaw);
  }

  // 1b. Try GOOGLE_APPLICATION_CREDENTIALS file path
  const credPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (credPath) {
    const { readFileSync } = await import("node:fs");
    const json = readFileSync(credPath, "utf8");
    return await getAccessTokenFromServiceAccountJson(json);
  }

  // 2. Try GCE metadata server
  try {
    const response = await fetch(
      "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token",
      { headers: { "Metadata-Flavor": "Google" }, signal: AbortSignal.timeout(2000) },
    );
    if (response.ok) {
      const data = (await response.json()) as { access_token: string };
      return data.access_token;
    }
  } catch {
    // Not on GCE, try next method
  }

  // 3. Try gcloud CLI
  try {
    const { execSync } = await import("node:child_process");
    const token = execSync("gcloud auth print-access-token", { encoding: "utf8" }).trim();
    if (token) return token;
  } catch {
    // gcloud not available
  }

  throw new Error(
    "No Vertex AI credentials found. Set VERTEX_AI_SERVICE_ACCOUNT_KEY (inline JSON), " +
      "GOOGLE_APPLICATION_CREDENTIALS (file path), or run on GCP with a service account.",
  );
}

/** Token cache to avoid re-signing JWTs on every call */
let _cachedToken: { token: string; expiresAt: number } | null = null;

async function getAccessTokenFromServiceAccountJson(jsonStr: string): Promise<string> {
  // Return cached token if still valid (with 60s buffer)
  if (_cachedToken && Date.now() < _cachedToken.expiresAt - 60_000) {
    return _cachedToken.token;
  }

  const sa = JSON.parse(jsonStr) as {
    client_email: string;
    private_key: string;
    token_uri?: string;
  };

  const now = Math.floor(Date.now() / 1000);
  const exp = now + 3600;

  const header = { alg: "RS256", typ: "JWT" };
  const claim = {
    iss: sa.client_email,
    scope: "https://www.googleapis.com/auth/cloud-platform",
    aud: sa.token_uri ?? "https://oauth2.googleapis.com/token",
    iat: now,
    exp,
  };

  const { createSign } = await import("node:crypto");

  const encode = (obj: unknown) =>
    Buffer.from(JSON.stringify(obj)).toString("base64url");

  const unsigned = `${encode(header)}.${encode(claim)}`;
  const signer = createSign("RSA-SHA256");
  signer.update(unsigned);
  const signature = signer.sign(sa.private_key, "base64url");
  const jwt = `${unsigned}.${signature}`;

  const tokenUri = sa.token_uri ?? "https://oauth2.googleapis.com/token";
  const response = await fetch(tokenUri, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Failed to get access token from service account: ${response.status} ${text}`);
  }

  const data = (await response.json()) as { access_token: string; expires_in: number };

  _cachedToken = {
    token: data.access_token,
    expiresAt: Date.now() + data.expires_in * 1000,
  };

  return data.access_token;
}
