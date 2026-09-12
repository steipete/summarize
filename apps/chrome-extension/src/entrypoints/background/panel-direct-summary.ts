import {
  buildDirectSummaryPrompt,
  DIRECT_SUMMARY_SYSTEM_PROMPT,
  resolveDirectMaxTokens,
} from "../../lib/direct-prompts";
import { completeDirectText, providerLabel } from "../../lib/direct-provider";
import { getProviderSettings, type Settings } from "../../lib/settings";
import type { ExtractResponse } from "./content-script-bridge";

export async function summarizePanelDirectly({
  extracted,
  title,
  transcriptTimedText,
  settings,
  signal,
  fetchImpl,
}: {
  extracted: ExtractResponse & { ok: true };
  title: string | null;
  transcriptTimedText: string | null;
  settings: Settings;
  signal: AbortSignal;
  fetchImpl: typeof fetch;
}): Promise<{ text: string; model: string }> {
  const prompt = buildDirectSummaryPrompt({
    url: extracted.url,
    title,
    text: extracted.text,
    transcriptTimedText,
    truncated: extracted.truncated,
    settings,
  });
  const result = await completeDirectText({
    model: settings.model,
    providerSettings: getProviderSettings(settings),
    system: DIRECT_SUMMARY_SYSTEM_PROMPT,
    prompt,
    maxTokens: resolveDirectMaxTokens(settings),
    signal,
    fetchImpl,
  });
  return {
    text: result.text,
    model: `${providerLabel(result.config.provider)} · ${result.config.model}`,
  };
}
