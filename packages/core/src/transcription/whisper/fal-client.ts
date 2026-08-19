const FAL_REST_API_URL = "https://rest.fal.ai";
const FAL_QUEUE_API_URL = "https://queue.fal.run";
const FAL_POLL_INTERVAL_MS = 500;
const FAL_MAX_RETRIES = 3;
const FAL_RETRY_BASE_DELAY_MS = 1_000;
const FAL_SINGLE_UPLOAD_MAX_BYTES = 90 * 1024 * 1024;
const FAL_MULTIPART_CHUNK_BYTES = 10 * 1024 * 1024;
const FAL_RETRYABLE_STATUS_CODES = new Set([429, 502, 503, 504]);
const FAL_RETRYABLE_NETWORK_CODES = new Set([
  "ECONNABORTED",
  "ECONNREFUSED",
  "ECONNRESET",
  "EAI_AGAIN",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENOTFOUND",
  "EPIPE",
  "ETIMEDOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_SOCKET",
]);

type FalClientOptions = {
  credentials: string;
  fetchImpl?: typeof fetch;
};

type FalSubscribeOptions = {
  input: Record<string, unknown>;
  signal?: AbortSignal;
};

type FalQueueStatus = {
  status?: unknown;
  error?: unknown;
};

type FalUploadInitiation = {
  uploadUrl: string;
  fileUrl: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (!isRecord(value)) return null;
  for (const key of ["message", "detail", "error"]) {
    const message = errorMessage(value[key]);
    if (message) return message;
  }
  return null;
}

async function readResponseBody(response: Response): Promise<unknown> {
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (contentType.includes("application/json")) {
    return await response.json();
  }
  const text = await response.text();
  return text || null;
}

function isRetryableNetworkError(error: unknown): boolean {
  const seen = new Set<object>();
  let current = error;
  while (typeof current === "object" && current !== null && !seen.has(current)) {
    seen.add(current);
    const shaped = current as { cause?: unknown; code?: unknown; name?: unknown };
    if (shaped.name === "AbortError" || shaped.name === "TimeoutError") return false;
    if (typeof shaped.code === "string" && FAL_RETRYABLE_NETWORK_CODES.has(shaped.code))
      return true;
    current = shaped.cause;
  }
  return error instanceof TypeError && /fetch failed/i.test(error.message);
}

function abortableDelay(ms: number, signal?: AbortSignal | null): Promise<void> {
  if (!signal) return new Promise((resolve) => setTimeout(resolve, ms));
  if (signal.aborted) return Promise.reject(signal.reason);

  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function fetchWithRetry(
  fetchImpl: typeof fetch,
  input: string,
  init: RequestInit,
): Promise<Response> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const response = await fetchImpl(input, init);
      if (!FAL_RETRYABLE_STATUS_CODES.has(response.status) || attempt >= FAL_MAX_RETRIES) {
        return response;
      }
      try {
        await response.body?.cancel();
      } catch {
        // The retry still proceeds if discarding the failed response body fails.
      }
    } catch (error) {
      if (attempt >= FAL_MAX_RETRIES || !isRetryableNetworkError(error)) throw error;
    }
    await abortableDelay(FAL_RETRY_BASE_DELAY_MS * 2 ** attempt, init.signal);
  }
}

async function fetchJson(
  fetchImpl: typeof fetch,
  input: string,
  init: RequestInit,
): Promise<Record<string, unknown>> {
  const response = await fetchWithRetry(fetchImpl, input, init);
  const body = await readResponseBody(response);
  if (!response.ok) {
    const details = errorMessage(body);
    throw new Error(
      `FAL request failed (${response.status}${response.statusText ? ` ${response.statusText}` : ""})${
        details ? `: ${details}` : ""
      }`,
    );
  }
  if (!isRecord(body)) {
    throw new Error("FAL returned an invalid response");
  }
  return body;
}

function authHeaders(credentials: string): Record<string, string> {
  return {
    Accept: "application/json",
    Authorization: `Key ${credentials}`,
  };
}

function resolveUploadFilename(file: Blob): string {
  const named = file as Blob & { name?: unknown };
  if (typeof named.name === "string" && named.name.trim()) return named.name.trim();
  const subtype = file.type.split("/")[1]?.split(/[;-]/)[0]?.trim();
  return `audio.${subtype || "bin"}`;
}

async function initiateUpload({
  fetchImpl,
  headers,
  file,
  multipart,
}: {
  fetchImpl: typeof fetch;
  headers: Record<string, string>;
  file: Blob;
  multipart: boolean;
}): Promise<FalUploadInitiation> {
  const route = multipart ? "initiate-multipart" : "initiate";
  const initiated = await fetchJson(
    fetchImpl,
    `${FAL_REST_API_URL}/storage/upload/${route}?storage_type=fal-cdn-v3`,
    {
      method: "POST",
      headers: {
        ...headers,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        content_type: file.type || "application/octet-stream",
        file_name: resolveUploadFilename(file),
      }),
    },
  );
  const uploadUrl = initiated.upload_url;
  const fileUrl = initiated.file_url;
  if (typeof uploadUrl !== "string" || typeof fileUrl !== "string") {
    throw new Error("FAL upload initiation returned an invalid response");
  }
  return { uploadUrl, fileUrl };
}

function uploadFailure(response: Response): Error {
  return new Error(
    `FAL upload failed (${response.status}${response.statusText ? ` ${response.statusText}` : ""})`,
  );
}

async function uploadSingle({
  fetchImpl,
  headers,
  file,
}: {
  fetchImpl: typeof fetch;
  headers: Record<string, string>;
  file: Blob;
}): Promise<string> {
  const { uploadUrl, fileUrl } = await initiateUpload({
    fetchImpl,
    headers,
    file,
    multipart: false,
  });
  const response = await fetchWithRetry(fetchImpl, uploadUrl, {
    method: "PUT",
    headers: {
      "Content-Type": file.type || "application/octet-stream",
    },
    body: file,
  });
  if (!response.ok) throw uploadFailure(response);
  return fileUrl;
}

async function uploadMultipart({
  fetchImpl,
  headers,
  file,
}: {
  fetchImpl: typeof fetch;
  headers: Record<string, string>;
  file: Blob;
}): Promise<string> {
  const { uploadUrl, fileUrl } = await initiateUpload({
    fetchImpl,
    headers,
    file,
    multipart: true,
  });
  const parsedUploadUrl = new URL(uploadUrl);
  const parts: Array<{ partNumber: number; etag: string }> = [];
  const partCount = Math.ceil(file.size / FAL_MULTIPART_CHUNK_BYTES);
  for (let index = 0; index < partCount; index += 1) {
    const partNumber = index + 1;
    const partUrl = `${parsedUploadUrl.origin}${parsedUploadUrl.pathname}/${partNumber}${parsedUploadUrl.search}`;
    const response = await fetchWithRetry(fetchImpl, partUrl, {
      method: "PUT",
      body: file.slice(
        index * FAL_MULTIPART_CHUNK_BYTES,
        Math.min((index + 1) * FAL_MULTIPART_CHUNK_BYTES, file.size),
      ),
    });
    if (!response.ok) throw uploadFailure(response);
    const body = await readResponseBody(response);
    if (!isRecord(body) || typeof body.etag !== "string") {
      throw new Error("FAL multipart upload returned an invalid part response");
    }
    parts.push({ partNumber, etag: body.etag });
  }

  const completeUrl = `${parsedUploadUrl.origin}${parsedUploadUrl.pathname}/complete${parsedUploadUrl.search}`;
  const completed = await fetchWithRetry(fetchImpl, completeUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ parts }),
  });
  if (!completed.ok) throw uploadFailure(completed);
  return fileUrl;
}

async function waitForQueueResult({
  fetchImpl,
  credentials,
  statusUrl,
  responseUrl,
  signal,
}: {
  fetchImpl: typeof fetch;
  credentials: string;
  statusUrl: string;
  responseUrl: string;
  signal?: AbortSignal;
}): Promise<Record<string, unknown>> {
  while (true) {
    const status = (await fetchJson(fetchImpl, statusUrl, {
      method: "GET",
      headers: authHeaders(credentials),
      signal,
    })) as FalQueueStatus;
    if (status.status === "COMPLETED") {
      if (status.error) {
        throw new Error(`FAL request failed: ${errorMessage(status.error) ?? "unknown error"}`);
      }
      return await fetchJson(fetchImpl, responseUrl, {
        method: "GET",
        headers: authHeaders(credentials),
        signal,
      });
    }
    if (status.status !== "IN_QUEUE" && status.status !== "IN_PROGRESS") {
      throw new Error(`FAL returned an unknown queue status: ${String(status.status)}`);
    }
    await abortableDelay(FAL_POLL_INTERVAL_MS, signal);
  }
}

export function createFalClient({
  credentials,
  fetchImpl = globalThis.fetch.bind(globalThis),
}: FalClientOptions) {
  const headers = authHeaders(credentials);

  return {
    storage: {
      upload: async (file: Blob): Promise<string> =>
        file.size > FAL_SINGLE_UPLOAD_MAX_BYTES
          ? await uploadMultipart({ fetchImpl, headers, file })
          : await uploadSingle({ fetchImpl, headers, file }),
    },
    subscribe: async (endpoint: string, options: FalSubscribeOptions) => {
      const normalizedEndpoint = endpoint
        .split("/")
        .filter(Boolean)
        .map((segment) => encodeURIComponent(segment))
        .join("/");
      if (!normalizedEndpoint) throw new Error("Missing FAL endpoint");

      const submitted = await fetchJson(fetchImpl, `${FAL_QUEUE_API_URL}/${normalizedEndpoint}`, {
        method: "POST",
        headers: {
          ...headers,
          "Content-Type": "application/json",
          "X-Fal-Queue-Priority": "normal",
        },
        body: JSON.stringify(options.input),
        signal: options.signal,
      });
      const requestId = typeof submitted.request_id === "string" ? submitted.request_id.trim() : "";
      if (!requestId) throw new Error("FAL queue submission returned no request ID");

      const requestBase = `${FAL_QUEUE_API_URL}/${normalizedEndpoint}/requests/${encodeURIComponent(
        requestId,
      )}`;
      const data = await waitForQueueResult({
        fetchImpl,
        credentials,
        statusUrl: `${requestBase}/status`,
        responseUrl: requestBase,
        signal: options.signal,
      });
      return { data, requestId };
    },
  };
}
