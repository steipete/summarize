import http from "node:http";

export function json(
  res: http.ServerResponse,
  status: number,
  payload: unknown,
  headers?: Record<string, string>,
) {
  const body = `${JSON.stringify(payload)}\n`;
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body).toString(),
    ...headers,
  });
  res.end(body);
}

export function text(
  res: http.ServerResponse,
  status: number,
  body: string,
  headers?: Record<string, string>,
) {
  const out = body.endsWith("\n") ? body : `${body}\n`;
  res.writeHead(status, {
    "content-type": "text/plain; charset=utf-8",
    "content-length": Buffer.byteLength(out).toString(),
    ...headers,
  });
  res.end(out);
}

export function clampNumber(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
}

function resolveOriginHeader(req: http.IncomingMessage): string | null {
  const origin = req.headers.origin;
  if (typeof origin !== "string" || !origin.trim()) return null;
  return origin;
}

export function isTrustedOrigin(origin: string): boolean {
  if (/^(?:chrome-extension|moz-extension|safari-web-extension):\/\//i.test(origin)) return true;
  try {
    const parsed = new URL(origin);
    return (
      parsed.hostname === "localhost" ||
      parsed.hostname === "127.0.0.1" ||
      parsed.hostname === "[::1]"
    );
  } catch {
    return false;
  }
}

export function corsHeaders(origin: string | null): Record<string, string> {
  if (!origin || !isTrustedOrigin(origin)) return {};
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-credentials": "true",
    "access-control-allow-headers": "authorization, content-type",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-private-network": "true",
    "access-control-max-age": "600",
    vary: "Origin",
  };
}

export function readCorsHeaders(req: http.IncomingMessage): Record<string, string> {
  return corsHeaders(resolveOriginHeader(req));
}

export function readBearerToken(req: http.IncomingMessage): string | null {
  const header = req.headers.authorization;
  if (typeof header !== "string") return null;
  // i18n-ignore: HTTP Authorization scheme and framing.
  return header.match(/^Bearer\s+(.+)\s*$/i)?.[1]?.trim() || null;
}

export async function readJsonBody(req: http.IncomingMessage, maxBytes: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.byteLength;
    if (total > maxBytes) throw new Error(`Body too large (>${maxBytes} bytes)`);
    chunks.push(buf);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export function wantsJsonResponse(req: http.IncomingMessage, url: URL): boolean {
  const format = url.searchParams.get("format");
  if (format && format.toLowerCase() === "json") return true;
  const accept = req.headers.accept;
  if (typeof accept !== "string") return false;
  const lower = accept.toLowerCase();
  if (lower.includes("text/event-stream")) return false;
  return lower.includes("application/json");
}
