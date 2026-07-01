import { daemonFetch } from "../../lib/daemon-fetch";
import { daemonOrigin } from "../../lib/daemon-url";
import { logExtensionEvent } from "../../lib/extension-logs";
import { createCachedExtract, type CachedExtract } from "./cached-extract";
import type { PanelSession } from "./panel-session-store";

type SlidesContextResponse =
  | { type: "slides:context"; requestId: string; ok: false; error: string }
  | { type: "slides:context"; requestId: string; ok: true; transcriptTimedText: string | null };

export async function handlePanelSlidesContextRequest<Recovery, Status>(options: {
  session: PanelSession<Recovery, Status>;
  requestId: string;
  requestedUrl: string | null;
  loadSettings: typeof import("../../lib/settings").loadSettings;
  getActiveTab: typeof import("./panel-utils").getActiveTab;
  canSummarizeUrl: (url: string | null | undefined) => boolean;
  panelSessionStore: {
    getCachedExtract: (tabId: number, url?: string | null) => CachedExtract | null;
    setCachedExtract: (tabId: number, payload: CachedExtract) => void;
  };
  urlsMatch: typeof import("./panel-utils").urlsMatch;
  send: (message: SlidesContextResponse) => void;
  fetchImpl?: typeof fetch;
  resolveLogLevel: (event: string) => "verbose" | "warn" | "error";
}) {
  const {
    session,
    requestId,
    requestedUrl,
    loadSettings,
    getActiveTab,
    canSummarizeUrl,
    panelSessionStore,
    urlsMatch,
    send,
    fetchImpl,
    resolveLogLevel,
  } = options;
  const settings = await loadSettings();
  const logSlides = (event: string, detail?: Record<string, unknown>) => {
    if (!settings.extendedLogging) return;
    const payload = detail ? { event, ...detail } : { event };
    logExtensionEvent({
      event,
      detail: detail ?? {},
      scope: "slides:bg",
      level: resolveLogLevel(event),
    });
    console.debug("[summarize][slides:bg]", payload);
  };
  const tab = await getActiveTab(session.windowId);
  const tabUrl = typeof tab?.url === "string" ? tab.url : null;
  const targetUrl = requestedUrl ?? tabUrl;
  if (!targetUrl || !canSummarizeUrl(targetUrl)) {
    send({
      type: "slides:context",
      requestId,
      ok: false,
      error: "No active tab for slides.",
    });
    logSlides("context:error", { reason: "no-tab", url: targetUrl });
    return;
  }

  const canUseCache = Boolean(tab?.id && tabUrl && urlsMatch(tabUrl, targetUrl));
  let cached = canUseCache ? panelSessionStore.getCachedExtract(tab.id, tabUrl ?? null) : null;
  let transcriptTimedText = cached?.transcriptTimedText ?? null;

  if (!transcriptTimedText && settings.token.trim()) {
    const origin = daemonOrigin(settings.daemonPort);

    try {
      const res = await (fetchImpl ?? daemonFetch)(`${origin}/v1/summarize`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${settings.token.trim()}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          url: targetUrl,
          mode: "url",
          extractOnly: true,
          timestamps: true,
          maxCharacters: null,
        }),
      });
      const json = (await res.json()) as {
        ok?: boolean;
        extracted?: { transcriptTimedText?: string | null } | null;
        error?: string;
      };
      if (!res.ok || !json?.ok) {
        throw new Error(json?.error || `${res.status} ${res.statusText}`);
      }
      transcriptTimedText = json.extracted?.transcriptTimedText ?? null;
      if (transcriptTimedText) {
        if (!cached && canUseCache && tab?.id && tabUrl) {
          cached = createCachedExtract({
            extracted: {
              url: tabUrl,
              title: tab.title?.trim() ?? null,
              text: "",
              truncated: false,
              media: null,
            },
            source: "url",
            title: tab.title?.trim() ?? null,
            wordCount: null,
            transcript: { timedText: transcriptTimedText },
          });
        } else if (cached) {
          cached = { ...cached, transcriptTimedText };
        }
        if (cached && tab?.id) {
          panelSessionStore.setCachedExtract(tab.id, cached);
        }
      }
      logSlides("context:fetch-transcript", {
        ok: Boolean(transcriptTimedText),
        url: targetUrl,
      });
    } catch (err) {
      logSlides("context:fetch-error", {
        url: targetUrl,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  send({
    type: "slides:context",
    requestId,
    ok: true,
    transcriptTimedText,
  });
  logSlides("context:ready", {
    url: targetUrl,
    transcriptTimedText: Boolean(transcriptTimedText),
    slides: cached?.slides?.slides?.length ?? 0,
  });
}
