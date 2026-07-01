import { type DaemonPolicy, readDaemonPolicy } from "./daemon-policy";

export const DAEMON_PERMISSION = "nativeMessaging" as const;

type PermissionsApi = Pick<typeof chrome.permissions, "contains" | "request">;

export type DaemonPermissionResult =
  | { granted: true; reason: "already-granted" | "granted" }
  | { granted: false; reason: "managed" | "denied" | "unsupported" };

function getPermissionsApi(): PermissionsApi | null {
  return globalThis.chrome?.permissions ?? null;
}

export async function hasDaemonPermission(
  permissionsApi: PermissionsApi | null = getPermissionsApi(),
): Promise<boolean> {
  if (!permissionsApi) return false;
  try {
    return await permissionsApi.contains({ permissions: [DAEMON_PERMISSION] });
  } catch {
    return false;
  }
}

export async function requestDaemonPermission(
  options: {
    policy?: DaemonPolicy;
    permissionsApi?: PermissionsApi | null;
    skipContains?: boolean;
  } = {},
): Promise<DaemonPermissionResult> {
  const policy = options.policy ?? (await readDaemonPolicy());
  if (!policy.daemonAllowed) return { granted: false, reason: "managed" };
  const permissionsApi = options.permissionsApi ?? getPermissionsApi();
  if (!permissionsApi) return { granted: false, reason: "unsupported" };
  if (!options.skipContains && (await hasDaemonPermission(permissionsApi))) {
    return { granted: true, reason: "already-granted" };
  }
  try {
    const granted = await permissionsApi.request({ permissions: [DAEMON_PERMISSION] });
    return granted ? { granted: true, reason: "granted" } : { granted: false, reason: "denied" };
  } catch {
    return { granted: false, reason: "denied" };
  }
}
