import { afterEach, describe, expect, it, vi } from "vitest";

const { readDaemonPolicy } = vi.hoisted(() => ({
  readDaemonPolicy: vi.fn(),
}));

vi.mock("../apps/chrome-extension/src/lib/daemon-policy", () => ({ readDaemonPolicy }));

import {
  bindNativeDaemonBridge,
  connectNativeOrReload,
  DAEMON_BRIDGE_PORT_NAME,
  NATIVE_MESSAGING_HOST_NAME,
} from "../apps/chrome-extension/src/lib/daemon-fetch";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

function createEvent<TArgs extends unknown[]>() {
  const listeners: Array<(...args: TArgs) => void> = [];
  return {
    addListener: vi.fn((listener: (...args: TArgs) => void) => listeners.push(listener)),
    emit: (...args: TArgs) => {
      for (const listener of listeners) listener(...args);
    },
  };
}

function createPort(name: string) {
  const onMessage = createEvent<[unknown]>();
  const onDisconnect = createEvent<[]>();
  const postMessage = vi.fn();
  const disconnect = vi.fn();
  const port = {
    name,
    onMessage,
    onDisconnect,
    postMessage,
    disconnect,
  } as unknown as chrome.runtime.Port;
  return { port, onMessage, onDisconnect, postMessage, disconnect };
}

function createBridgeHarness({
  permission = vi.fn(async () => true),
}: {
  permission?: ReturnType<typeof vi.fn>;
} = {}) {
  const onConnect = createEvent<[chrome.runtime.Port]>();
  const native = createPort("");
  const connectNative = vi.fn(() => native.port);
  const reload = vi.fn();
  vi.stubEnv("BROWSER", "chrome");
  vi.stubGlobal("chrome", {
    permissions: { contains: permission },
    runtime: { connectNative, lastError: undefined, onConnect, reload },
  });
  bindNativeDaemonBridge();

  const client = createPort(DAEMON_BRIDGE_PORT_NAME);
  onConnect.emit(client.port);
  return { client, connectNative, native, permission };
}

async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
}

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("connectNativeOrReload", () => {
  it("reloads a stale extension context and asks the caller to retry", () => {
    const reload = vi.fn();

    expect(() =>
      connectNativeOrReload({ connectNative: undefined, reload }, NATIVE_MESSAGING_HOST_NAME),
    ).toThrow("Local companion enabled — extension reloaded; reopen it and retry");
    expect(reload).toHaveBeenCalledOnce();
  });

  it("opens the native host when the API is available", () => {
    const port = {} as chrome.runtime.Port;
    const connectNative = vi.fn(() => port);
    const reload = vi.fn();

    expect(connectNativeOrReload({ connectNative, reload }, NATIVE_MESSAGING_HOST_NAME)).toBe(port);
    expect(connectNative).toHaveBeenCalledWith(NATIVE_MESSAGING_HOST_NAME);
    expect(reload).not.toHaveBeenCalled();
  });
});

describe("bindNativeDaemonBridge", () => {
  it("does not request permission after cancellation during the policy check", async () => {
    const policy = deferred<{ daemonAllowed: boolean; managed: boolean }>();
    readDaemonPolicy.mockReturnValueOnce(policy.promise);
    const harness = createBridgeHarness();

    harness.client.onMessage.emit({ type: "request" });
    expect(readDaemonPolicy).toHaveBeenCalledOnce();
    harness.client.onMessage.emit({ type: "cancel" });
    policy.resolve({ daemonAllowed: true, managed: false });
    await flushMicrotasks();

    expect(harness.permission).not.toHaveBeenCalled();
    expect(harness.connectNative).not.toHaveBeenCalled();
  });

  it("does not connect after cancellation during the permission check", async () => {
    readDaemonPolicy.mockResolvedValueOnce({ daemonAllowed: true, managed: false });
    const permission = deferred<boolean>();
    const harness = createBridgeHarness({
      permission: vi.fn(() => permission.promise),
    });

    harness.client.onMessage.emit({ type: "request" });
    await vi.waitFor(() => expect(harness.permission).toHaveBeenCalledOnce());
    harness.client.onMessage.emit({ type: "cancel" });
    permission.resolve(true);
    await flushMicrotasks();

    expect(harness.connectNative).not.toHaveBeenCalled();
    expect(harness.native.postMessage).not.toHaveBeenCalled();
  });

  it("does not connect after the client disconnects during the permission check", async () => {
    readDaemonPolicy.mockResolvedValueOnce({ daemonAllowed: true, managed: false });
    const permission = deferred<boolean>();
    const harness = createBridgeHarness({
      permission: vi.fn(() => permission.promise),
    });

    harness.client.onMessage.emit({ type: "request" });
    await vi.waitFor(() => expect(harness.permission).toHaveBeenCalledOnce());
    harness.client.onDisconnect.emit();
    permission.resolve(true);
    await flushMicrotasks();

    expect(harness.connectNative).not.toHaveBeenCalled();
    expect(harness.native.postMessage).not.toHaveBeenCalled();
  });

  it("forwards cancellation after the native host is connected", async () => {
    readDaemonPolicy.mockResolvedValueOnce({ daemonAllowed: true, managed: false });
    const harness = createBridgeHarness();
    const request = { type: "request", method: "GET", path: "/health" };

    harness.client.onMessage.emit(request);
    await vi.waitFor(() => expect(harness.connectNative).toHaveBeenCalledOnce());
    harness.client.onMessage.emit({ type: "cancel" });

    expect(harness.native.postMessage).toHaveBeenNthCalledWith(1, request);
    expect(harness.native.postMessage).toHaveBeenNthCalledWith(2, { type: "cancel" });
    expect(harness.native.disconnect).toHaveBeenCalledOnce();
  });
});
