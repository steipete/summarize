import { beforeEach, describe, expect, it, vi } from "vitest";
import { createRuntimeActionsHandler } from "../apps/chrome-extension/src/entrypoints/background/runtime-actions";

const storage = new Map<string, unknown>();
const TAB_ID = 777;

function installChromeStorage() {
  (globalThis as unknown as { chrome: unknown }).chrome = {
    storage: {
      session: {
        async get(key: string) {
          return { [key]: storage.get(key) };
        },
        async set(value: Record<string, unknown>) {
          for (const [key, val] of Object.entries(value)) storage.set(key, val);
        },
      },
    },
  };
}

function createHandler() {
  return createRuntimeActionsHandler({
    nativeInputArmedTabs: new Set<number>(),
    artifactsArmedTabs: new Set<number>(),
  });
}

function dispatchArtifact(
  handler: ReturnType<typeof createHandler>,
  raw: unknown,
  tabId: number | undefined = TAB_ID,
): Promise<unknown> {
  return new Promise((resolve) => {
    const sender = typeof tabId === "number" ? ({ tab: { id: tabId } } as any) : ({} as any);
    const ret = handler(raw, sender, resolve);
    expect(ret).toBe(true);
  });
}

describe("runtime artifact bridge guard", () => {
  beforeEach(() => {
    storage.clear();
    installChromeStorage();
  });

  it("blocks page-origin artifact reads unless the tab is armed by extension code", async () => {
    storage.set(`automation.artifacts.${TAB_ID}`, {
      "legit-secret.txt": {
        fileName: "legit-secret.txt",
        mimeType: "text/plain",
        contentBase64: btoa("LEGIT_AUTOMATION_ARTIFACT_SECRET"),
        size: 32,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    });
    const handler = createHandler();

    const blocked = await dispatchArtifact(handler, {
      type: "automation:artifacts",
      requestId: "attacker-read-existing",
      action: "getArtifact",
      payload: { fileName: "legit-secret.txt" },
    });

    expect(blocked).toEqual({ ok: false, error: "Artifacts bridge not armed for this tab" });
  });

  it("ignores page-origin attempts to arm the artifact bridge", async () => {
    const handler = createHandler();
    const armResponse = vi.fn();

    handler(
      { type: "automation:artifacts-arm", tabId: TAB_ID, enabled: true },
      { tab: { id: TAB_ID } } as any,
      armResponse,
    );

    const blocked = await dispatchArtifact(handler, {
      type: "automation:artifacts",
      requestId: "attacker-create",
      action: "createOrUpdateArtifact",
      payload: { fileName: "attacker-note.txt", content: "PAGE_CONTROLLED" },
    });

    expect(armResponse).not.toHaveBeenCalled();
    expect(blocked).toEqual({ ok: false, error: "Artifacts bridge not armed for this tab" });
  });

  it("allows artifact operations only while extension code has armed the tab", async () => {
    const handler = createHandler();

    handler({ type: "automation:artifacts-arm", tabId: TAB_ID, enabled: true }, {} as any, vi.fn());
    const created = await dispatchArtifact(handler, {
      type: "automation:artifacts",
      requestId: "trusted-create",
      action: "createOrUpdateArtifact",
      payload: {
        fileName: "trusted-note.txt",
        content: "TRUSTED_AUTOMATION_ARTIFACT",
        mimeType: "text/plain",
      },
    });
    expect(created).toMatchObject({ ok: true });

    handler(
      { type: "automation:artifacts-arm", tabId: TAB_ID, enabled: false },
      {} as any,
      vi.fn(),
    );
    const blockedAfterDisarm = await dispatchArtifact(handler, {
      type: "automation:artifacts",
      requestId: "late-read",
      action: "getArtifact",
      payload: { fileName: "trusted-note.txt" },
    });

    expect(blockedAfterDisarm).toEqual({
      ok: false,
      error: "Artifacts bridge not armed for this tab",
    });
  });
});
