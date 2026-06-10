import { describe, expect, it, vi } from "vitest";
import { createPanelSessionStore } from "../apps/chrome-extension/src/entrypoints/background/panel-session-store.js";

describe("panel session persistent cache bridge", () => {
  it("hydrates panel cache from the persistent backend", async () => {
    const cached = { tabId: 99, url: "https://example.com", value: "cached" };
    const persistent = {
      getPanel: vi.fn(async () => cached),
      setPanel: vi.fn(async () => undefined),
      clear: vi.fn(async () => ({ ok: true })),
      stats: vi.fn(async () => ({ ok: true })),
    };
    const store = createPanelSessionStore<
      { url: string },
      typeof cached,
      Record<string, never>,
      Record<string, never>
    >({
      createDaemonRecovery: () => ({}),
      createDaemonStatus: () => ({}),
      persistentPanelCache: persistent,
    });

    const result = await store.getPanelCacheAsync(7, "https://example.com");

    expect(result).toEqual({ ...cached, tabId: 7 });
    expect(store.getPanelCache(7, "https://example.com")).toEqual({ ...cached, tabId: 7 });
  });

  it("keeps a fresh in-memory snapshot when persistent hydration returns late", async () => {
    let resolvePersistent: ((value: typeof stale) => void) | null = null;
    const stale = { tabId: 99, url: "https://example.com", value: "stale" };
    const fresh = { tabId: 7, url: "https://example.com", value: "fresh" };
    const persistent = {
      getPanel: vi.fn(
        () =>
          new Promise<typeof stale>((resolve) => {
            resolvePersistent = resolve;
          }),
      ),
      setPanel: vi.fn(async () => undefined),
      clear: vi.fn(async () => ({ ok: true })),
      stats: vi.fn(async () => ({ ok: true })),
    };
    const store = createPanelSessionStore<
      { url: string },
      typeof stale,
      Record<string, never>,
      Record<string, never>
    >({
      createDaemonRecovery: () => ({}),
      createDaemonStatus: () => ({}),
      persistentPanelCache: persistent,
    });

    const hydration = store.getPanelCacheAsync(7, "https://example.com");
    store.storePanelCache(fresh);
    resolvePersistent?.(stale);

    expect(await hydration).toEqual(fresh);
    expect(store.getPanelCache(7, "https://example.com")).toEqual(fresh);
  });

  it("uses persistent cache only when the runtime gate allows it", async () => {
    const cached = { tabId: 99, url: "https://example.com", value: "cached" };
    const persistent = {
      getPanel: vi.fn(async () => cached),
      setPanel: vi.fn(async () => undefined),
      clear: vi.fn(async () => ({ ok: true })),
      stats: vi.fn(async () => ({ ok: true })),
    };
    let enabled = false;
    const store = createPanelSessionStore<
      { url: string },
      typeof cached,
      Record<string, never>,
      Record<string, never>
    >({
      createDaemonRecovery: () => ({}),
      createDaemonStatus: () => ({}),
      persistentPanelCache: persistent,
      shouldUsePersistentPanelCache: () => enabled,
    });

    store.storePanelCache(cached);
    await Promise.resolve();
    expect(persistent.setPanel).not.toHaveBeenCalled();
    expect(await store.getPanelCacheAsync(7, "https://other.example")).toBeNull();
    expect(persistent.getPanel).not.toHaveBeenCalled();

    enabled = true;
    store.storePanelCache({ ...cached, url: "https://stored.example" });
    await Promise.resolve();
    expect(persistent.setPanel).toHaveBeenCalled();
    expect(await store.getPanelCacheAsync(7, "https://example.com")).toEqual({
      ...cached,
      tabId: 7,
    });
  });

  it("does not persist a snapshot whose runtime gate resolves after clear", async () => {
    let resolveGate: ((value: boolean) => void) | null = null;
    const cached = { tabId: 7, url: "https://example.com", value: "cached" };
    const persistent = {
      getPanel: vi.fn(async () => cached),
      setPanel: vi.fn(async () => undefined),
      clear: vi.fn(async () => ({ ok: true })),
      stats: vi.fn(async () => ({ ok: true })),
    };
    const store = createPanelSessionStore<
      { url: string },
      typeof cached,
      Record<string, never>,
      Record<string, never>
    >({
      createDaemonRecovery: () => ({}),
      createDaemonStatus: () => ({}),
      persistentPanelCache: persistent,
      shouldUsePersistentPanelCache: () =>
        new Promise<boolean>((resolve) => {
          resolveGate = resolve;
        }),
    });

    store.storePanelCache(cached);
    await store.clearPersistentPanelCache();
    resolveGate?.(true);
    await Promise.resolve();

    expect(persistent.setPanel).not.toHaveBeenCalled();
  });

  it("does not hydrate a persistent snapshot whose gate resolves after clear", async () => {
    let resolveGate: ((value: boolean) => void) | null = null;
    const cached = { tabId: 9, url: "https://example.com", value: "cached" };
    const persistent = {
      getPanel: vi.fn(async () => cached),
      setPanel: vi.fn(async () => undefined),
      clear: vi.fn(async () => ({ ok: true })),
      stats: vi.fn(async () => ({ ok: true })),
    };
    const store = createPanelSessionStore<
      { url: string },
      typeof cached,
      Record<string, never>,
      Record<string, never>
    >({
      createDaemonRecovery: () => ({}),
      createDaemonStatus: () => ({}),
      persistentPanelCache: persistent,
      shouldUsePersistentPanelCache: () =>
        new Promise<boolean>((resolve) => {
          resolveGate = resolve;
        }),
    });

    const hydration = store.getPanelCacheAsync(7, "https://example.com");
    await store.clearPersistentPanelCache();
    resolveGate?.(true);

    expect(await hydration).toBeNull();
    expect(store.getPanelCache(7, "https://example.com")).toBeNull();
  });

  it("does not let an older async snapshot overwrite a newer persistent write", async () => {
    const first = { tabId: 7, url: "https://example.com", value: "first" };
    const second = { tabId: 7, url: "https://example.com", value: "second" };
    const gateResolvers: Array<(value: boolean) => void> = [];
    const persistent = {
      getPanel: vi.fn(async () => null),
      setPanel: vi.fn(async () => undefined),
      clear: vi.fn(async () => ({ ok: true })),
      stats: vi.fn(async () => ({ ok: true })),
    };
    const store = createPanelSessionStore<
      { url: string },
      typeof first,
      Record<string, never>,
      Record<string, never>
    >({
      createDaemonRecovery: () => ({}),
      createDaemonStatus: () => ({}),
      persistentPanelCache: persistent,
      shouldUsePersistentPanelCache: () =>
        new Promise<boolean>((resolve) => {
          gateResolvers.push(resolve);
        }),
    });

    store.storePanelCache(first);
    store.storePanelCache(second);
    gateResolvers[1]?.(true);
    await Promise.resolve();
    gateResolvers[0]?.(true);
    await Promise.resolve();

    expect(persistent.setPanel).toHaveBeenCalledTimes(1);
    expect(persistent.setPanel).toHaveBeenCalledWith(second);
  });

  it("orders persistent writes by URL across tabs", async () => {
    const first = { tabId: 7, url: "https://example.com", value: "first" };
    const second = { tabId: 8, url: "https://example.com", value: "second" };
    const gateResolvers: Array<(value: boolean) => void> = [];
    const persistent = {
      getPanel: vi.fn(async () => null),
      setPanel: vi.fn(async () => undefined),
      clear: vi.fn(async () => ({ ok: true })),
      stats: vi.fn(async () => ({ ok: true })),
    };
    const store = createPanelSessionStore<
      { url: string },
      typeof first,
      Record<string, never>,
      Record<string, never>
    >({
      createDaemonRecovery: () => ({}),
      createDaemonStatus: () => ({}),
      persistentPanelCache: persistent,
      shouldUsePersistentPanelCache: () =>
        new Promise<boolean>((resolve) => {
          gateResolvers.push(resolve);
        }),
    });

    store.storePanelCache(first);
    store.storePanelCache(second);
    gateResolvers[1]?.(true);
    await Promise.resolve();
    gateResolvers[0]?.(true);
    await Promise.resolve();

    expect(persistent.setPanel).toHaveBeenCalledTimes(1);
    expect(persistent.setPanel).toHaveBeenCalledWith(second);
  });

  it("does not hydrate stale persistent data after the tab cache changes", async () => {
    let resolvePersistent: ((value: typeof stale) => void) | null = null;
    const stale = { tabId: 9, url: "https://example.com/old", value: "old" };
    const fresh = { tabId: 7, url: "https://example.com/new", value: "new" };
    const persistent = {
      getPanel: vi.fn(
        () =>
          new Promise<typeof stale>((resolve) => {
            resolvePersistent = resolve;
          }),
      ),
      setPanel: vi.fn(async () => undefined),
      clear: vi.fn(async () => ({ ok: true })),
      stats: vi.fn(async () => ({ ok: true })),
    };
    const store = createPanelSessionStore<
      { url: string },
      typeof stale,
      Record<string, never>,
      Record<string, never>
    >({
      createDaemonRecovery: () => ({}),
      createDaemonStatus: () => ({}),
      persistentPanelCache: persistent,
      shouldUsePersistentPanelCache: () => true,
    });

    const hydration = store.getPanelCacheAsync(7, "https://example.com/old");
    await Promise.resolve();
    store.storePanelCache(fresh);
    resolvePersistent?.(stale);

    expect(await hydration).toBeNull();
    expect(store.getPanelCache(7, "https://example.com/new")).toEqual(fresh);
  });

  it("passes tab and url to the persistent runtime gate", async () => {
    const cached = { tabId: 42, url: "https://example.com", value: "cached" };
    const shouldUsePersistentPanelCache = vi.fn(() => false);
    const persistent = {
      getPanel: vi.fn(async () => null),
      setPanel: vi.fn(async () => undefined),
      clear: vi.fn(async () => ({ ok: true })),
      stats: vi.fn(async () => ({ ok: true })),
    };
    const store = createPanelSessionStore<
      { url: string },
      typeof cached,
      Record<string, never>,
      Record<string, never>
    >({
      createDaemonRecovery: () => ({}),
      createDaemonStatus: () => ({}),
      persistentPanelCache: persistent,
      shouldUsePersistentPanelCache,
    });

    store.storePanelCache(cached);
    await Promise.resolve();
    await store.getPanelCacheAsync(42, "https://other.example");

    expect(shouldUsePersistentPanelCache).toHaveBeenCalledWith(
      expect.objectContaining({
        tabId: 42,
        url: "https://example.com",
      }),
    );
    expect(shouldUsePersistentPanelCache).toHaveBeenCalledWith(
      expect.objectContaining({
        tabId: 42,
        url: "https://other.example",
      }),
    );
    expect(persistent.setPanel).not.toHaveBeenCalled();
    expect(persistent.getPanel).not.toHaveBeenCalled();
  });
});
