import { fetchBrowserUrlContent, isPublicBrowserUrl } from "../../lib/browser-url-content";
import { streamDirectModel } from "../../lib/direct-provider";
import { logExtensionEvent } from "../../lib/extension-logs";
import { resolveCapabilityExecution, resolveCapabilityModel } from "../../lib/model-routing";
import { parseSseEvent } from "../../lib/runtime-contracts";
import { getProviderSettings, loadSettings } from "../../lib/settings";
import { parseSseStream } from "../../lib/sse";
import { friendlyFetchError } from "./daemon-client";

export type HoverToBg =
  | {
      type: "hover:summarize";
      requestId: string;
      url: string;
      title: string | null;
      token?: string;
    }
  | { type: "hover:abort"; requestId: string };

type BgToHover =
  | { type: "hover:chunk"; requestId: string; url: string; text: string }
  | { type: "hover:done"; requestId: string; url: string }
  | { type: "hover:error"; requestId: string; url: string; message: string };

function safeSendResponse(sendResponse: (response?: unknown) => void, value: unknown) {
  try {
    sendResponse(value);
  } catch {
    // ignore
  }
}

async function sendHover(tabId: number, msg: BgToHover) {
  try {
    await chrome.tabs.sendMessage(tabId, msg);
  } catch {
    // ignore
  }
}

async function resolveHoverTabId(sender: chrome.runtime.MessageSender): Promise<number | null> {
  if (sender.tab?.id) return sender.tab.id;
  const senderUrl = typeof sender.url === "string" ? sender.url : null;
  const tabs = await chrome.tabs.query({});
  if (senderUrl) {
    const match = tabs.find((tab) => tab.url === senderUrl);
    if (match?.id) return match.id;
  }
  const active = tabs.find((tab) => tab.active);
  return active?.id ?? null;
}

export function isHoverSummarizeUrlAllowed(rawUrl: string): boolean {
  return isPublicBrowserUrl(rawUrl);
}

export function createHoverController({
  hoverControllersByTabId,
  buildDaemonRequestBody,
  resolveLogLevel,
}: {
  hoverControllersByTabId: Map<number, { requestId: string; controller: AbortController }>;
  buildDaemonRequestBody: typeof import("../../lib/daemon-payload").buildDaemonRequestBody;
  resolveLogLevel: (event: string) => "verbose" | "warn" | "error";
}) {
  const abortHoverForTab = (tabId: number, requestId?: string) => {
    const existing = hoverControllersByTabId.get(tabId);
    if (!existing) return;
    if (requestId && existing.requestId !== requestId) return;
    existing.controller.abort();
    hoverControllersByTabId.delete(tabId);
  };

  const runHoverSummarize = async (
    tabId: number,
    msg: HoverToBg & { type: "hover:summarize" },
    opts?: { onStart?: (result: { ok: boolean; error?: string }) => void },
  ) => {
    abortHoverForTab(tabId);
    let didNotifyStart = false;
    const notifyStart = (result: { ok: boolean; error?: string }) => {
      if (didNotifyStart) return;
      didNotifyStart = true;
      opts?.onStart?.(result);
    };

    const controller = new AbortController();
    hoverControllersByTabId.set(tabId, { requestId: msg.requestId, controller });

    const isStillActive = () => {
      const current = hoverControllersByTabId.get(tabId);
      return Boolean(current && current.requestId === msg.requestId && !controller.signal.aborted);
    };

    const settings = await loadSettings();
    const logHover = (event: string, detail?: Record<string, unknown>) => {
      if (!settings.extendedLogging) return;
      const payload = detail ? { event, ...detail } : { event };
      logExtensionEvent({
        event,
        detail: detail ?? {},
        scope: "hover:bg",
        level: resolveLogLevel(event),
      });
      console.debug("[summarize][hover:bg]", payload);
    };
    const token = msg.token?.trim() || settings.token.trim();
    const capabilityExecution = resolveCapabilityExecution(settings);
    if (capabilityExecution === "unavailable") {
      const message = "Hover summaries require a configured direct provider or the daemon";
      notifyStart({ ok: false, error: message });
      await sendHover(tabId, {
        type: "hover:error",
        requestId: msg.requestId,
        url: msg.url,
        message,
      });
      return;
    }
    if (capabilityExecution === "daemon" && !token) {
      notifyStart({ ok: false, error: "Setup required (missing token)" });
      await sendHover(tabId, {
        type: "hover:error",
        requestId: msg.requestId,
        url: msg.url,
        message: "Setup required (missing token)",
      });
      return;
    }

    if (!isHoverSummarizeUrlAllowed(msg.url)) {
      const message = "Hover summaries can only summarize public HTTP(S) URLs";
      notifyStart({ ok: false, error: message });
      await sendHover(tabId, {
        type: "hover:error",
        requestId: msg.requestId,
        url: msg.url,
        message,
      });
      return;
    }

    try {
      logHover("start", { tabId, requestId: msg.requestId, url: msg.url });
      if (capabilityExecution === "direct") {
        const content = await fetchBrowserUrlContent({
          url: msg.url,
          maxCharacters: Math.min(settings.maxChars, 60_000),
          signal: controller.signal,
        });
        if (!isStillActive()) return;
        notifyStart({ ok: true });
        const prompt = `${settings.hoverPrompt}

Source URL: ${content.url}
Page name: ${content.title ?? msg.title ?? ""}

<content>
${content.text}
</content>`;
        for await (const event of streamDirectModel({
          model: resolveCapabilityModel(settings.model),
          providerSettings: getProviderSettings(settings),
          system:
            "Summarize the linked page. Return plain text only and follow the user's length constraints.",
          messages: [{ role: "user", content: prompt, timestamp: Date.now() }],
          maxTokens: 512,
          signal: controller.signal,
        })) {
          if (!isStillActive()) return;
          if (event.type !== "text" || !event.text) continue;
          await sendHover(tabId, {
            type: "hover:chunk",
            requestId: msg.requestId,
            url: msg.url,
            text: event.text,
          });
        }
        if (!isStillActive()) return;
        await sendHover(tabId, { type: "hover:done", requestId: msg.requestId, url: msg.url });
        return;
      }

      const base = buildDaemonRequestBody({
        extracted: { url: msg.url, title: msg.title, text: "", truncated: false },
        settings: { ...settings, model: resolveCapabilityModel(settings.model) },
      });
      const body = {
        ...base,
        length: "short",
        prompt: settings.hoverPrompt,
        mode: "url",
        timeout: "30s",
      };

      const res = await fetch("http://127.0.0.1:8787/v1/summarize", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      const json = (await res.json()) as { ok?: boolean; id?: string; error?: string };
      if (!res.ok || !json?.ok || !json.id) {
        throw new Error(json?.error || `${res.status} ${res.statusText}`);
      }

      if (!isStillActive()) return;
      notifyStart({ ok: true });
      logHover("stream-start", { tabId, requestId: msg.requestId, url: msg.url, runId: json.id });

      const streamRes = await fetch(`http://127.0.0.1:8787/v1/summarize/${json.id}/events`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: controller.signal,
      });
      if (!streamRes.ok) throw new Error(`${streamRes.status} ${streamRes.statusText}`);
      if (!streamRes.body) throw new Error("Missing stream body");

      for await (const raw of parseSseStream(streamRes.body)) {
        if (!isStillActive()) return;
        const event = parseSseEvent(raw);
        if (!event) continue;
        if (event.event === "chunk") {
          if (!event.data.text) continue;
          await sendHover(tabId, {
            type: "hover:chunk",
            requestId: msg.requestId,
            url: msg.url,
            text: event.data.text,
          });
        } else if (event.event === "error") {
          throw new Error(event.data.message);
        } else if (event.event === "done") {
          break;
        }
      }

      if (!isStillActive()) return;
      logHover("done", { tabId, requestId: msg.requestId, url: msg.url });
      await sendHover(tabId, { type: "hover:done", requestId: msg.requestId, url: msg.url });
    } catch (err) {
      if (!isStillActive()) return;
      const errorContext =
        capabilityExecution === "direct"
          ? "Direct hover summary failed"
          : "Daemon hover summary failed";
      notifyStart({
        ok: false,
        error: friendlyFetchError(err, errorContext),
      });
      logHover("error", {
        tabId,
        requestId: msg.requestId,
        url: msg.url,
        message: err instanceof Error ? err.message : String(err),
      });
      await sendHover(tabId, {
        type: "hover:error",
        requestId: msg.requestId,
        url: msg.url,
        message: friendlyFetchError(err, errorContext),
      });
    } finally {
      notifyStart({ ok: false, error: "Hover summarize aborted" });
      abortHoverForTab(tabId, msg.requestId);
    }
  };

  const handleRuntimeMessage = (
    raw: unknown,
    sender: chrome.runtime.MessageSender,
    sendResponse: (response?: unknown) => void,
  ): boolean | undefined => {
    if (!raw || typeof raw !== "object" || typeof (raw as { type?: unknown }).type !== "string") {
      return;
    }

    const message = raw as HoverToBg;

    if (message.type === "hover:summarize") {
      void (async () => {
        const tabId = await resolveHoverTabId(sender);
        if (!tabId) {
          safeSendResponse(sendResponse, { ok: false, error: "Missing sender tab" });
          return;
        }

        const startResult = await new Promise<{ ok: boolean; error?: string }>((resolve) => {
          void runHoverSummarize(tabId, message, { onStart: resolve });
        });
        safeSendResponse(sendResponse, startResult);
      })();
      return true;
    }

    if (message.type === "hover:abort") {
      const tabId = sender.tab?.id;
      if (!tabId) return;
      abortHoverForTab(tabId, message.requestId);
      return;
    }
  };

  return { abortHoverForTab, handleRuntimeMessage };
}
