import { parseSseStream } from "@steipete/summarize-core/runtime";
import { readPresetOrCustomValue } from "../../lib/combo";
import { daemonFetch } from "../../lib/daemon-fetch";
import { daemonOrigin } from "../../lib/daemon-url";
import { createModelPresetsController as createSharedModelPresetsController } from "../../lib/model-presets";
import { parseSseEvent } from "../../lib/runtime-contracts";
import type { Settings } from "../../lib/settings";

type StatusState = "idle" | "running" | "error" | "ok";

export function createModelPresetsController({
  modelPresetEl,
  modelCustomEl,
  modelRefreshBtn,
  modelStatusEl,
  modelRowEl,
  defaultModel,
  loadSettings,
  friendlyFetchError,
  fetchImpl = daemonFetch,
}: {
  modelPresetEl: HTMLSelectElement;
  modelCustomEl: HTMLInputElement;
  modelRefreshBtn: HTMLButtonElement;
  modelStatusEl: HTMLElement;
  modelRowEl: HTMLElement;
  defaultModel: string;
  loadSettings: () => Promise<Settings>;
  friendlyFetchError: (error: unknown, context: string) => string;
  fetchImpl?: typeof fetch;
}) {
  let refreshFreeRunning = false;

  const setStatus = (text: string, state: StatusState = "idle") => {
    modelStatusEl.textContent = text;
    if (state === "idle") {
      modelStatusEl.removeAttribute("data-state");
    } else {
      modelStatusEl.setAttribute("data-state", state);
    }
  };

  const presets = createSharedModelPresetsController({
    presetEl: modelPresetEl,
    customEl: modelCustomEl,
    defaultValue: defaultModel,
    includeFree: true,
    fetchImpl,
    onUpdate: () => {
      modelRowEl.classList.toggle("isCustom", modelPresetEl.value === "custom");
      modelRefreshBtn.hidden = modelPresetEl.value !== "free";
    },
  });
  const { refreshPresets } = presets;
  const readCurrentValue = () =>
    readPresetOrCustomValue({
      presetValue: modelPresetEl.value,
      customValue: modelCustomEl.value,
      defaultValue: defaultModel,
    });
  const refreshIfStale = () => presets.refreshIfStale(async () => (await loadSettings()).token);

  const runRefreshFree = async () => {
    if (refreshFreeRunning) return;
    const settings = await loadSettings();
    const token = settings.token.trim();
    const origin = daemonOrigin(settings.daemonPort);
    if (!token) {
      setStatus("Setup required (missing token).", "error");
      return;
    }
    refreshFreeRunning = true;
    modelRefreshBtn.disabled = true;
    setStatus("Starting scan…", "running");
    let winnerModel: string | null = null;

    try {
      const response = await fetchImpl(`${origin}/v1/refresh-free`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({}),
      });
      const json = (await response.json()) as { ok?: boolean; id?: string; error?: string };
      if (!response.ok || !json.ok || !json.id) {
        throw new Error(json.error || `${response.status} ${response.statusText}`);
      }

      const streamResponse = await fetchImpl(`${origin}/v1/refresh-free/${json.id}/events`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!streamResponse.ok)
        throw new Error(`${streamResponse.status} ${streamResponse.statusText}`);
      if (!streamResponse.body) throw new Error("Missing stream body");

      for await (const raw of parseSseStream(streamResponse.body)) {
        const event = parseSseEvent(raw);
        if (!event) continue;
        if (event.event === "status") {
          const text = event.data.text.trim();
          if (text) {
            if (!winnerModel) {
              const match = text.match(/^-\s+([^\s]+)/);
              if (match?.[1]) winnerModel = match[1];
            }
            setStatus(text, "running");
          }
        } else if (event.event === "error") {
          throw new Error(event.data.message);
        } else if (event.event === "done") {
          break;
        }
      }

      const winnerNote = winnerModel ? ` Top: ${winnerModel}` : "";
      setStatus(`Free models updated.${winnerNote}`, "ok");
      await refreshPresets(token);
    } catch (error) {
      setStatus(friendlyFetchError(error, "Refresh free failed"), "error");
    } finally {
      refreshFreeRunning = false;
      modelRefreshBtn.disabled = false;
    }
  };

  return {
    ...presets,
    isRefreshFreeRunning: () => refreshFreeRunning,
    readCurrentValue,
    refreshIfStale,
    refreshPresets,
    runRefreshFree,
    setStatus,
  };
}
