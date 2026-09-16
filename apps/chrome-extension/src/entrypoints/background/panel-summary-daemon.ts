import { daemonOrigin } from "../../lib/daemon-url";
import { LocalizedError, readLocalizedMessage } from "../../lib/i18n";
import type { Settings } from "../../lib/settings";
import type { ExtractResponse } from "./content-script-bridge";

type SlidesConfig =
  | { enabled: false }
  | {
      enabled: true;
      ocr: boolean;
      maxSlides: number | null;
      minDurationSeconds: number | null;
    };

export async function startPanelDaemonSummary(options: {
  extracted: ExtractResponse & { ok: true };
  settings: Settings;
  noCache: boolean;
  inputMode?: "page" | "video";
  timestamps: boolean;
  slides: SlidesConfig;
  signal: AbortSignal;
  fetchImpl: typeof fetch;
  buildSummarizeRequestBody: (args: {
    extracted: ExtractResponse & { ok: true };
    settings: Settings;
    noCache: boolean;
    inputMode?: "page" | "video";
    timestamps: boolean;
    slides: SlidesConfig;
  }) => Record<string, unknown>;
  log: (event: string, detail?: Record<string, unknown>) => void;
}): Promise<string> {
  const body = options.buildSummarizeRequestBody({
    extracted: options.extracted,
    settings: options.settings,
    noCache: options.noCache,
    inputMode: options.inputMode,
    timestamps: options.timestamps,
    slides: options.slides,
  });
  options.log("summarize:request", {
    url: options.extracted.url,
    slides: options.slides.enabled,
    slideRuntime: options.settings.slideRuntime,
    slidesParallel: false,
    timestamps: options.timestamps,
  });
  const origin = daemonOrigin(options.settings.daemonPort);
  const response = await options.fetchImpl(`${origin}/v1/summarize`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${options.settings.token.trim()}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
    signal: options.signal,
  });
  const json = (await response.json()) as {
    ok: boolean;
    id?: string;
    error?: string;
    localized?: unknown;
  };
  if (!response.ok || !json.ok || !json.id) {
    const localized = readLocalizedMessage(json.localized);
    if (localized) throw new LocalizedError(localized);
    throw new Error(json.error || `${response.status} ${response.statusText}`);
  }
  return json.id;
}
