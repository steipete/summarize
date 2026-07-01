import { Buffer } from "node:buffer";
import type { Readable, Writable } from "node:stream";
import { readDaemonConfig } from "./config.js";
import { CHROME_EXTENSION_ID, DAEMON_HOST } from "./constants.js";

const MAX_INBOUND_MESSAGE_BYTES = 64 * 1024 * 1024;
const MAX_RESPONSE_CHUNK_BYTES = 192 * 1024;
const ALLOWED_REQUEST_HEADERS = new Set([
  "accept",
  "authorization",
  "cache-control",
  "content-type",
  "last-event-id",
]);

type NativeRequest = {
  type: "request";
  method?: string;
  path: string;
  port?: number;
  headers?: Record<string, string>;
  body?: string;
};

type NativeCancel = { type: "cancel" };

export type NativeHostInput = NativeRequest | NativeCancel;

export type NativeHostOutput =
  | { type: "response"; status: number; statusText: string; headers: Array<[string, string]> }
  | { type: "chunk"; data: string }
  | { type: "end" }
  | { type: "error"; message: string };

function parseCallerOrigin(argv: readonly string[]): string | null {
  return argv.find((value) => value.startsWith("chrome-extension://")) ?? null;
}

function assertAllowedCaller(argv: readonly string[], extensionId: string): void {
  const origin = parseCallerOrigin(argv);
  const expected = `chrome-extension://${extensionId}/`;
  if (origin !== expected) throw new Error("Native messaging caller is not allowed");
}

function normalizeRequestPath(raw: unknown): string {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 16_384) {
    throw new Error("Invalid native request path");
  }
  const base = `http://${DAEMON_HOST}`;
  const url = new URL(raw, base);
  if (url.origin !== base) throw new Error("Native requests must use a relative daemon path");
  if (url.pathname !== "/health" && !url.pathname.startsWith("/v1/")) {
    throw new Error("Native request path is not allowed");
  }
  return `${url.pathname}${url.search}`;
}

function normalizeMethod(raw: unknown): string {
  const method = typeof raw === "string" ? raw.toUpperCase() : "GET";
  if (method !== "GET" && method !== "POST" && method !== "DELETE") {
    throw new Error("Native request method is not allowed");
  }
  return method;
}

function normalizeHeaders(raw: unknown): Headers {
  const headers = new Headers();
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return headers;
  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    const normalizedName = name.toLowerCase();
    if (!ALLOWED_REQUEST_HEADERS.has(normalizedName) || typeof value !== "string") continue;
    headers.set(normalizedName, value);
  }
  return headers;
}

export function encodeNativeMessage(value: NativeHostOutput | NativeHostInput): Buffer {
  const body = Buffer.from(JSON.stringify(value), "utf8");
  const header = Buffer.allocUnsafe(4);
  header.writeUInt32LE(body.byteLength, 0);
  return Buffer.concat([header, body]);
}

export function createNativeMessageDecoder(
  onMessage: (message: unknown) => void,
): (chunk: Uint8Array) => void {
  let buffered = Buffer.alloc(0);
  return (chunk) => {
    buffered = Buffer.concat([buffered, Buffer.from(chunk)]);
    while (buffered.byteLength >= 4) {
      const length = buffered.readUInt32LE(0);
      if (length === 0 || length > MAX_INBOUND_MESSAGE_BYTES) {
        throw new Error("Invalid native message length");
      }
      if (buffered.byteLength < 4 + length) return;
      const payload = buffered.subarray(4, 4 + length);
      buffered = buffered.subarray(4 + length);
      onMessage(JSON.parse(payload.toString("utf8")));
    }
  };
}

function createMessageWriter(stdout: Writable) {
  let pending = Promise.resolve();
  return (message: NativeHostOutput) => {
    const frame = encodeNativeMessage(message);
    pending = pending.then(
      () =>
        new Promise<void>((resolve, reject) => {
          stdout.write(frame, (error) => {
            if (error) reject(error);
            else resolve();
          });
        }),
    );
    return pending;
  };
}

export async function runNativeMessagingHost({
  env,
  argv,
  stdin,
  stdout,
  extensionId = CHROME_EXTENSION_ID,
  fetchImpl = fetch,
}: {
  env: Record<string, string | undefined>;
  argv: readonly string[];
  stdin: Readable;
  stdout: Writable;
  extensionId?: string;
  fetchImpl?: typeof fetch;
}): Promise<void> {
  assertAllowedCaller(argv, extensionId);

  const writeMessage = createMessageWriter(stdout);
  const controller = new AbortController();
  let requestStarted = false;
  let requestTask: Promise<void> | null = null;

  const handleRequest = async (message: NativeRequest) => {
    const config = await readDaemonConfig({ env });
    if (!config) throw new Error("Local companion is not installed");
    if (message.port !== config.port) {
      throw new Error("Extension and local companion ports do not match");
    }
    const path = normalizeRequestPath(message.path);
    const method = normalizeMethod(message.method);
    const headers = normalizeHeaders(message.headers);
    const body = message.body ? Buffer.from(message.body, "base64") : undefined;
    if ((method === "GET" || method === "DELETE") && body?.byteLength) {
      throw new Error(`${method} requests cannot include a body`);
    }

    const response = await fetchImpl(`http://${DAEMON_HOST}:${config.port}${path}`, {
      method,
      headers,
      body,
      signal: controller.signal,
    });
    await writeMessage({
      type: "response",
      status: response.status,
      statusText: response.statusText,
      headers: Array.from(response.headers.entries()),
    });

    if (response.body) {
      const reader = response.body.getReader();
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        for (let offset = 0; offset < value.byteLength; offset += MAX_RESPONSE_CHUNK_BYTES) {
          const chunk = value.subarray(offset, offset + MAX_RESPONSE_CHUNK_BYTES);
          await writeMessage({ type: "chunk", data: Buffer.from(chunk).toString("base64") });
        }
      }
    }
    await writeMessage({ type: "end" });
  };

  const decoder = createNativeMessageDecoder((raw) => {
    if (!raw || typeof raw !== "object") throw new Error("Invalid native message");
    const message = raw as NativeHostInput;
    if (message.type === "cancel") {
      controller.abort();
      return;
    }
    if (message.type !== "request" || requestStarted) {
      throw new Error("Expected one native request per connection");
    }
    requestStarted = true;
    requestTask = handleRequest(message).catch(async (error: unknown) => {
      const messageText =
        error instanceof Error && error.name === "AbortError"
          ? "Native request cancelled"
          : error instanceof Error
            ? error.message
            : String(error);
      await writeMessage({ type: "error", message: messageText });
    });
  });

  for await (const chunk of stdin) decoder(chunk as Uint8Array);
  await requestTask;
}
