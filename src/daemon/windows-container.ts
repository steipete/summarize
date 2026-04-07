const WINDOWS_CONTAINER_INSTALL_MODE_ENV = "SUMMARIZE_WINDOWS_CONTAINER_MODE";
const WINDOWS_CONTAINER_MARKERS = [
  "CONTAINER_SANDBOX_MOUNT_POINT",
  "DOTNET_RUNNING_IN_CONTAINER",
  "RUNNING_IN_CONTAINER",
] as const;

function isTruthyEnvValue(value: string | undefined): boolean {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return normalized !== "" && normalized !== "0" && normalized !== "false" && normalized !== "no";
}

export function isWindowsContainerEnvironment(env: Record<string, string | undefined>): boolean {
  const override = env[WINDOWS_CONTAINER_INSTALL_MODE_ENV]?.trim().toLowerCase();
  if (override === "container") return true;
  if (override === "desktop") return false;
  return WINDOWS_CONTAINER_MARKERS.some((key) => isTruthyEnvValue(env[key]));
}
