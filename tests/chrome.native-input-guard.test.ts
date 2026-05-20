import { describe, expect, it, vi } from "vitest";
import {
  getNativeInputGuardError,
  updateNativeInputArmedTabs,
  withNativeInputArmedTab,
} from "../apps/chrome-extension/src/automation/native-input-guard";

describe("chrome native input guard", () => {
  it("arms and disarms tabs only for extension-page messages", () => {
    const armedTabs = new Set<number>();

    expect(
      updateNativeInputArmedTabs({
        armedTabs,
        senderHasTab: true,
        tabId: 7,
        enabled: true,
      }),
    ).toBe(false);
    expect(armedTabs.has(7)).toBe(false);

    expect(
      updateNativeInputArmedTabs({
        armedTabs,
        senderHasTab: false,
        tabId: 7,
        enabled: true,
      }),
    ).toBe(true);
    expect(armedTabs.has(7)).toBe(true);

    expect(
      updateNativeInputArmedTabs({
        armedTabs,
        senderHasTab: false,
        tabId: 7,
        enabled: false,
      }),
    ).toBe(true);
    expect(armedTabs.has(7)).toBe(false);
  });

  it("rejects missing or unarmed sender tabs", () => {
    const armedTabs = new Set<number>([3]);

    expect(getNativeInputGuardError({ armedTabs, senderTabId: undefined })).toBe(
      "Missing sender tab",
    );
    expect(getNativeInputGuardError({ armedTabs, senderTabId: 4 })).toBe(
      "Native input not armed for this tab",
    );
    expect(getNativeInputGuardError({ armedTabs, senderTabId: 3 })).toBeNull();
  });

  it("requires a matching native-input capability when using capability-backed arms", () => {
    const armedTabs = new Map<number, string>([[3, "x".repeat(32)]]);

    expect(
      getNativeInputGuardError({
        armedTabs,
        senderTabId: 3,
        capability: "wrong".repeat(7),
      }),
    ).toBe("Native input capability mismatch");
    expect(
      getNativeInputGuardError({
        armedTabs,
        senderTabId: 3,
        capability: "x".repeat(32),
      }),
    ).toBeNull();
  });

  it("arms before execution and disarms after success", async () => {
    const sendMessage = vi.fn(async () => undefined);
    const run = vi.fn(async () => "ok");

    await expect(
      withNativeInputArmedTab({
        enabled: true,
        tabId: 9,
        sendMessage,
        capability: "c".repeat(32),
        run,
      }),
    ).resolves.toBe("ok");

    expect(sendMessage.mock.calls).toEqual([
      [
        {
          type: "automation:native-input-arm",
          tabId: 9,
          enabled: true,
          capability: "c".repeat(32),
        },
      ],
      [{ type: "automation:native-input-arm", tabId: 9, enabled: false, capability: null }],
    ]);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("disarms even when execution fails", async () => {
    const sendMessage = vi.fn(async () => undefined);
    const run = vi.fn(async () => {
      throw new Error("boom");
    });

    await expect(
      withNativeInputArmedTab({
        enabled: true,
        tabId: 11,
        sendMessage,
        capability: "d".repeat(32),
        run,
      }),
    ).rejects.toThrow("boom");

    expect(sendMessage.mock.calls).toEqual([
      [
        {
          type: "automation:native-input-arm",
          tabId: 11,
          enabled: true,
          capability: "d".repeat(32),
        },
      ],
      [{ type: "automation:native-input-arm", tabId: 11, enabled: false, capability: null }],
    ]);
  });
});
