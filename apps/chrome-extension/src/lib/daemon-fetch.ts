import { readDaemonPolicy } from "./daemon-policy";

declare const __SUMMARIZE_E2E_HTTP_TRANSPORT__: boolean;

export const NATIVE_MESSAGING_HOST_NAME = "com.steipete.summarize";
export const DAEMON_BRIDGE_PORT_NAME = "summarize:daemon-native";
const MAX_REQUEST_BODY_BYTES = 16 * 1024 * 1024;

type NativeRequestMessage = {
  type: "request";
  method: string;
  path: string;
  port: number;
  headers: Record<string, string>;
  body?: string;
};

type NativeResponseMessage =
  | { type: "response"; status: number; statusText: string; headers: Array<[string, string]> }
  | { type: "chunk"; data: string }
  | { type: "end" }
  | { type: "error"; message: string };

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 32_768;
  for (let offset = 0; offset < bytes.byteLength; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function normalizeDaemonUrl(raw: string): { path: string; port: number } {
  const url = new URL(raw);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1") {
    throw new Error("Local companion requests must target 127.0.0.1");
  }
  if (url.pathname !== "/health" && !url.pathname.startsWith("/v1/")) {
    throw new Error("Local companion request path is not allowed");
  }
  const port = Number(url.port || "80");
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error("Local companion port is invalid");
  }
  return { path: `${url.pathname}${url.search}`, port };
}

async function buildNativeRequest(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<NativeRequestMessage> {
  const request = new Request(input, init);
  const { path, port } = normalizeDaemonUrl(request.url);
  const headers: Record<string, string> = {};
  request.headers.forEach((value, name) => {
    headers[name] = value;
  });
  const message: NativeRequestMessage = {
    type: "request",
    method: request.method,
    path,
    port,
    headers,
  };
  if (request.method !== "GET" && request.method !== "HEAD") {
    const body = new Uint8Array(await request.arrayBuffer());
    if (body.byteLength > MAX_REQUEST_BODY_BYTES) {
      throw new Error("Local companion request body is too large");
    }
    if (body.byteLength > 0) message.body = bytesToBase64(body);
  }
  return message;
}

async function nativeDaemonFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
  connectPort: () => chrome.runtime.Port = () =>
    chrome.runtime.connect({ name: DAEMON_BRIDGE_PORT_NAME }),
): Promise<Response> {
  const requestMessage = await buildNativeRequest(input, init);
  const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
  if (signal?.aborted) throw new DOMException("The operation was aborted", "AbortError");

  return await new Promise<Response>((resolve, reject) => {
    const port = connectPort();
    let responseController: ReadableStreamDefaultController<Uint8Array> | null = null;
    let settled = false;
    let finished = false;

    const cleanup = () => {
      signal?.removeEventListener("abort", onAbort);
    };
    const finishPort = () => {
      try {
        port.disconnect();
      } catch {
        // Already disconnected.
      }
    };
    const fail = (error: Error) => {
      if (finished) return;
      finished = true;
      cleanup();
      if (settled) responseController?.error(error);
      else reject(error);
      finishPort();
    };
    const onAbort = () => {
      try {
        port.postMessage({ type: "cancel" });
      } catch {
        // The disconnect path below still settles the request.
      }
      const error = new DOMException("The operation was aborted", "AbortError");
      fail(error);
    };

    port.onMessage.addListener((raw: unknown) => {
      if (!raw || typeof raw !== "object") return;
      const message = raw as NativeResponseMessage;
      if (message.type === "response") {
        const body =
          message.status === 204 || message.status === 205 || message.status === 304
            ? null
            : new ReadableStream<Uint8Array>({
                start(controller) {
                  responseController = controller;
                },
                cancel() {
                  onAbort();
                },
              });
        settled = true;
        resolve(
          new Response(body, {
            status: message.status,
            statusText: message.statusText,
            headers: message.headers,
          }),
        );
        return;
      }
      if (message.type === "chunk") {
        responseController?.enqueue(base64ToBytes(message.data));
        return;
      }
      if (message.type === "end") {
        if (finished) return;
        finished = true;
        cleanup();
        responseController?.close();
        finishPort();
        return;
      }
      if (message.type === "error") fail(new Error(message.message));
    });
    port.onDisconnect.addListener(() => {
      if (finished) return;
      const detail = chrome.runtime.lastError?.message;
      fail(new Error(detail || "Local companion connection closed unexpectedly"));
    });
    signal?.addEventListener("abort", onAbort, { once: true });
    port.postMessage(requestMessage);
  });
}

export async function daemonFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  if (__SUMMARIZE_E2E_HTTP_TRANSPORT__) return await fetch(input, init);
  if (import.meta.env.BROWSER === "firefox") return await fetch(input, init);
  // Chrome does not dispatch runtime.onConnect when an MV3 service worker connects
  // back to its own extension. Background requests must open the native host directly;
  // extension pages still use the bridge so nativeMessaging stays out of page contexts.
  if (typeof document === "undefined") {
    const policy = await readDaemonPolicy();
    if (!policy.daemonAllowed) throw new Error("Local companion disabled by administrator");
    const permitted = await chrome.permissions.contains({ permissions: ["nativeMessaging"] });
    if (!permitted) throw new Error("Local companion permission is not enabled");
    return await nativeDaemonFetch(input, init, () =>
      chrome.runtime.connectNative(NATIVE_MESSAGING_HOST_NAME),
    );
  }
  return await nativeDaemonFetch(input, init);
}

export function bindNativeDaemonBridge(): void {
  if (import.meta.env.BROWSER !== "chrome") return;
  chrome.runtime.onConnect.addListener((clientPort) => {
    if (clientPort.name !== DAEMON_BRIDGE_PORT_NAME) return;
    let nativePort: chrome.runtime.Port | null = null;
    let started = false;
    let disconnected = false;

    const sendError = (message: string) => {
      if (disconnected) return;
      try {
        clientPort.postMessage({ type: "error", message });
      } catch {
        // The caller has gone away.
      }
    };
    const disconnectNative = () => {
      if (!nativePort) return;
      try {
        nativePort.disconnect();
      } catch {
        // Already disconnected.
      }
      nativePort = null;
    };

    clientPort.onMessage.addListener((raw: unknown) => {
      if (!raw || typeof raw !== "object") return;
      const message = raw as NativeRequestMessage | { type?: string };
      if (message.type === "cancel") {
        nativePort?.postMessage({ type: "cancel" });
        disconnectNative();
        return;
      }
      if (message.type !== "request" || started) return;
      started = true;
      void (async () => {
        const policy = await readDaemonPolicy();
        if (!policy.daemonAllowed) {
          sendError("Local companion disabled by administrator");
          return;
        }
        const permitted = await chrome.permissions.contains({ permissions: ["nativeMessaging"] });
        if (!permitted) {
          sendError("Local companion permission is not enabled");
          return;
        }
        try {
          nativePort = chrome.runtime.connectNative(NATIVE_MESSAGING_HOST_NAME);
        } catch (error) {
          sendError(error instanceof Error ? error.message : String(error));
          return;
        }
        nativePort.onMessage.addListener((nativeMessage: unknown) => {
          if (disconnected) return;
          try {
            clientPort.postMessage(nativeMessage);
          } catch {
            disconnectNative();
          }
        });
        nativePort.onDisconnect.addListener(() => {
          const detail = chrome.runtime.lastError?.message;
          sendError(detail || "Local companion host exited unexpectedly");
          nativePort = null;
        });
        nativePort.postMessage(message);
      })();
    });
    clientPort.onDisconnect.addListener(() => {
      disconnected = true;
      disconnectNative();
    });
  });
}
