import { expect, test } from "@playwright/test";
import { DAEMON_PERMISSION, requestDaemonPermission } from "../src/lib/daemon-permission";
import { enforceDaemonPolicy, normalizeDaemonPolicy } from "../src/lib/daemon-policy";

test("daemon policy normalization defaults open and accepts only booleans", () => {
  expect(normalizeDaemonPolicy(undefined)).toEqual({ daemonAllowed: true, managed: false });
  expect(normalizeDaemonPolicy({ daemonAllowed: "false" })).toEqual({
    daemonAllowed: true,
    managed: false,
  });
  expect(normalizeDaemonPolicy({ daemonAllowed: false })).toEqual({
    daemonAllowed: false,
    managed: true,
  });
  expect(normalizeDaemonPolicy({ daemonAllowed: true })).toEqual({
    daemonAllowed: true,
    managed: true,
  });
});

test("managed disable removes every daemon and CLI fallback path", () => {
  const settings = {
    token: "secret",
    summaryRuntime: "daemon" as const,
    slideRuntime: "daemon" as const,
    autoCliFallback: true,
    directSetting: "preserved",
  };
  expect(enforceDaemonPolicy(settings, { daemonAllowed: false, managed: true })).toEqual({
    token: "",
    summaryRuntime: "direct",
    slideRuntime: "browser",
    autoCliFallback: false,
    directSetting: "preserved",
  });
  expect(settings.token).toBe("secret");
});

test("allowed policy leaves Direct and Browser settings unaffected", () => {
  const settings = {
    token: "",
    summaryRuntime: "direct" as const,
    slideRuntime: "browser" as const,
    autoCliFallback: true,
    provider: "openai",
  };
  expect(enforceDaemonPolicy(settings, { daemonAllowed: true, managed: false })).toBe(settings);
});

test("daemon permission denial is explicit and requests only native messaging", async () => {
  const requests: chrome.permissions.Permissions[] = [];
  const permissionsApi = {
    contains: async () => false,
    request: async (permissions: chrome.permissions.Permissions) => {
      requests.push(permissions);
      return false;
    },
  } as Pick<typeof chrome.permissions, "contains" | "request">;

  await expect(
    requestDaemonPermission({
      policy: { daemonAllowed: true, managed: false },
      permissionsApi,
      skipContains: true,
    }),
  ).resolves.toEqual({ granted: false, reason: "denied" });
  expect(requests).toEqual([{ permissions: [DAEMON_PERMISSION] }]);
});

test("personal users can grant the optional local companion permission", async () => {
  const permissionsApi = {
    contains: async () => false,
    request: async (permissions: chrome.permissions.Permissions) =>
      permissions.permissions?.includes(DAEMON_PERMISSION) ?? false,
  } as Pick<typeof chrome.permissions, "contains" | "request">;

  await expect(
    requestDaemonPermission({
      policy: { daemonAllowed: true, managed: false },
      permissionsApi,
      skipContains: true,
    }),
  ).resolves.toEqual({ granted: true, reason: "granted" });
});

test("managed policy prevents a browser permission request", async () => {
  let requested = false;
  const permissionsApi = {
    contains: async () => false,
    request: async () => {
      requested = true;
      return true;
    },
  } as unknown as Pick<typeof chrome.permissions, "contains" | "request">;

  await expect(
    requestDaemonPermission({
      policy: { daemonAllowed: false, managed: true },
      permissionsApi,
    }),
  ).resolves.toEqual({ granted: false, reason: "managed" });
  expect(requested).toBe(false);
});
