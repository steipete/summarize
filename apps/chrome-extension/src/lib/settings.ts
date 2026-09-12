import { enforceDaemonPolicy, readDaemonPolicy } from "./daemon-policy";
import { normalizeSettings, normalizeStoredSettings } from "./settings-normalization";
import { readStoredSettings, writeStoredSettings } from "./settings-storage";
import type { Settings, EffectiveSettings, ProviderSettings } from "./settings-types";

export type {
  Settings,
  EffectiveSettings,
  SlidesLayout,
  SlideRuntime,
  SummaryRuntime,
  DirectProvider,
  ProviderSettings,
} from "./settings-types";
export { DEFAULT_DAEMON_PORT, defaultSettings } from "./settings-defaults";
export {
  MAX_MAX_CHARS,
  normalizeDaemonPort,
  normalizeSettingChoices,
} from "./settings-normalization";

export async function loadSettings(): Promise<EffectiveSettings> {
  const raw = (await readStoredSettings()) as Partial<Settings> & Record<string, unknown>;
  const normalized = normalizeStoredSettings(raw);
  const policy = await readDaemonPolicy();
  return {
    ...enforceDaemonPolicy(normalized, policy),
    daemonAllowed: policy.daemonAllowed,
    daemonManaged: policy.managed,
  };
}

export async function saveSettings(settings: Settings): Promise<void> {
  const {
    daemonAllowed: _daemonAllowed,
    daemonManaged: _daemonManaged,
    ...storedSettings
  } = settings as EffectiveSettings;

  await writeStoredSettings(normalizeSettings(storedSettings));
}

export function getProviderSettings(settings: Settings): ProviderSettings {
  return {
    provider: settings.provider,
    apiKeys: settings.providerApiKeys,
    baseUrls: settings.providerBaseUrls,
  };
}

export async function patchSettings(patch: Partial<Settings>): Promise<Settings> {
  const current = await loadSettings();
  const next = { ...current, ...patch };
  await saveSettings(next);
  return next;
}
