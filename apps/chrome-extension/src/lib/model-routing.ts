import { resolveDirectProviderForModel } from "./direct-provider";
import type { Settings } from "./settings";

export const GEMINI_NANO_MODEL = "browser/gemini-nano";
export const GEMINI_NANO_LABEL = "Gemini Nano";

export type SummaryExecution = "browser" | "direct" | "daemon";
export type CapabilityExecution = "direct" | "daemon" | "unavailable";

export function isGeminiNanoModel(model: string): boolean {
  const normalized = model.trim().toLowerCase();
  return (
    normalized === GEMINI_NANO_MODEL ||
    normalized === "chrome/gemini-nano" ||
    normalized === "gemini-nano"
  );
}

export function hasDirectProviderCredentials(settings: {
  model: string;
  provider: Settings["provider"];
  providerApiKeys: Record<string, string | undefined> | Partial<Record<string, string>>;
}): boolean {
  const provider = resolveDirectProviderForModel(settings.model, settings.provider);
  if (provider === "ollama") return true;
  return Boolean(settings.providerApiKeys[provider]?.trim());
}

export function resolveSummaryExecution(
  settings: Pick<Settings, "summaryRuntime" | "model"> & {
    provider: Settings["provider"];
    providerApiKeys: Record<string, string | undefined> | Partial<Record<string, string>>;
  },
): SummaryExecution {
  if (isGeminiNanoModel(settings.model)) return "browser";
  if (settings.summaryRuntime === "daemon") return "daemon";
  if (settings.model.trim().toLowerCase() === "auto" && !hasDirectProviderCredentials(settings)) {
    return "browser";
  }
  return "direct";
}

export function resolveCapabilityExecution(
  settings: Pick<Settings, "summaryRuntime" | "model"> & {
    provider: Settings["provider"];
    providerApiKeys: Record<string, string | undefined> | Partial<Record<string, string>>;
  },
): CapabilityExecution {
  if (settings.summaryRuntime === "daemon") return "daemon";
  return hasDirectProviderCredentials(settings) ? "direct" : "unavailable";
}

export function resolveCapabilityModel(model: string): string {
  return isGeminiNanoModel(model) ? "auto" : model;
}
