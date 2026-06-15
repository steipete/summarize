import { readPresetOrCustomValue } from "../../lib/combo";
import { parseSseEvent } from "../../lib/runtime-contracts";
import type { Settings } from "../../lib/settings";
import { parseSseStream } from "../../lib/sse";

type StatusState = "idle" | "running" | "error" | "ok";

export function createModelPresetsController({
  modelPresetEl,
  modelCustomEl,
  modelRefreshBtn,
  modelStatusEl,
  modelRowEl,
  defaultModel,
  defaultPlaceholder = "auto",
  loadSettings,
  friendlyFetchError,
}: {
  modelPresetEl: HTMLSelectElement;
  modelCustomEl: HTMLInputElement;
  modelRefreshBtn: HTMLButtonElement;
  modelStatusEl: HTMLElement;
  modelRowEl: HTMLElement;
  defaultModel: string;
  defaultPlaceholder?: string;
  loadSettings: () => Promise<Settings>;
  friendlyFetchError: (error: unknown, context: string) => string;
}) {
  let refreshAt = 0;
  let refreshFreeRunning = false;

  const setStatus = (text: string, state: StatusState = "idle") => {
    modelStatusEl.textContent = text;
    if (state === "idle") {
      modelStatusEl.removeAttribute("data-state");
    } else {
      modelStatusEl.setAttribute("data-state", state);
    }
  };

  const setDefaultPresets = () => {
    modelPresetEl.innerHTML = "";
    for (const { value, label } of [
      { value: "auto", label: "Auto" },
      { value: "browser/gemini-nano", label: "Gemini Nano (on-device)" },
      { value: "gpt-fast", label: "GPT Fast" },
      { value: "free", label: "Free" },
      { value: "custom", label: "Custom…" },
    ]) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = label;
      modelPresetEl.append(option);
    }
  };

  const setPlaceholderFromDiscovery = (discovery: {
    providers?: unknown;
    localModelsSource?: unknown;
  }) => {
    const hints: string[] = ["auto", "gpt-fast"];
    const providers = discovery.providers;
    if (providers && typeof providers === "object") {
      const record = providers as Record<string, unknown>;
      if (record.openrouter === true) hints.push("free");
      if (record.openai === true) hints.push("openai/…");
      if (record.anthropic === true) hints.push("anthropic/…");
      if (record.google === true) hints.push("google/…");
      if (record.xai === true) hints.push("xai/…");
      if (record.zai === true) hints.push("zai/…");
    }
    if (discovery.localModelsSource && typeof discovery.localModelsSource === "object") {
      hints.push("local: openai/<id>");
    }
    modelCustomEl.placeholder = hints.join(" / ") || defaultPlaceholder;
  };

  const readCurrentValue = () =>
    readPresetOrCustomValue({
      presetValue: modelPresetEl.value,
      customValue: modelCustomEl.value,
      defaultValue: defaultModel,
    });

  const updateRowUI = () => {
    const isCustom = modelPresetEl.value === "custom";
    modelCustomEl.hidden = !isCustom;
    modelRowEl.classList.toggle("isCustom", isCustom);
    modelRefreshBtn.hidden = modelPresetEl.value !== "free";
  };

  const setValue = (value: string) => {
    const next = value.trim() || defaultModel;
    const optionValues = new Set(Array.from(modelPresetEl.options).map((option) => option.value));
    if (optionValues.has(next) && next !== "custom") {
      modelPresetEl.value = next;
      updateRowUI();
      return;
    }
    modelPresetEl.value = "custom";
    updateRowUI();
    modelCustomEl.value = next;
  };

  const captureSelection = () => ({
    presetValue: modelPresetEl.value,
    customValue: modelCustomEl.value,
  });
  const sameSelection = (
    a: { presetValue: string; customValue: string },
    b: { presetValue: string; customValue: string },
  ) => a.presetValue === b.presetValue && a.customValue === b.customValue;

  const restoreSelection = (selection: { presetValue: string; customValue: string }) => {
    if (selection.presetValue === "custom") {
      modelPresetEl.value = "custom";
      updateRowUI();
      modelCustomEl.value = selection.customValue;
      return;
    }
    const optionValues = new Set(Array.from(modelPresetEl.options).map((option) => option.value));
    if (optionValues.has(selection.presetValue) && selection.presetValue !== "custom") {
      modelPresetEl.value = selection.presetValue;
      updateRowUI();
      return;
    }
    setValue(selection.presetValue);
  };

  let refreshRequestId = 0;
  const refreshPresets = async (token: string) => {
    const requestId = ++refreshRequestId;
    const selectionAtStart = captureSelection();
    const isCurrentRequest = () => requestId === refreshRequestId;
    const selectionToRestore = () => {
      const current = captureSelection();
      return sameSelection(current, selectionAtStart) ? selectionAtStart : current;
    };
    const trimmed = token.trim();
    if (!trimmed) {
      const selection = selectionToRestore();
      setDefaultPresets();
      setPlaceholderFromDiscovery({});
      restoreSelection(selection);
      return;
    }
    try {
      const response = await fetch("http://127.0.0.1:8787/v1/models", {
        headers: { Authorization: `Bearer ${trimmed}` },
      });
      if (!isCurrentRequest()) return;
      if (!response.ok) {
        const selection = selectionToRestore();
        setDefaultPresets();
        restoreSelection(selection);
        return;
      }
      const json = (await response.json()) as unknown;
      if (!isCurrentRequest()) return;
      if (!json || typeof json !== "object") return;
      const record = json as Record<string, unknown>;
      if (record.ok !== true) return;

      setPlaceholderFromDiscovery({
        providers: record.providers,
        localModelsSource: record.localModelsSource,
      });

      const optionsRaw = record.options;
      if (!Array.isArray(optionsRaw)) return;

      const options = optionsRaw
        .map((item) => {
          if (!item || typeof item !== "object") return null;
          const option = item as { id?: unknown; label?: unknown };
          const id = typeof option.id === "string" ? option.id.trim() : "";
          const label = typeof option.label === "string" ? option.label.trim() : "";
          if (!id) return null;
          return { id, label };
        })
        .filter((item): item is { id: string; label: string } => item !== null);

      if (options.length === 0) {
        const selection = selectionToRestore();
        setDefaultPresets();
        restoreSelection(selection);
        return;
      }

      const selection = selectionToRestore();
      setDefaultPresets();
      const seen = new Set(Array.from(modelPresetEl.options).map((option) => option.value));
      for (const option of options) {
        if (seen.has(option.id)) continue;
        seen.add(option.id);
        const el = document.createElement("option");
        el.value = option.id;
        el.textContent = option.label ? `${option.id} — ${option.label}` : option.id;
        modelPresetEl.append(el);
      }
      restoreSelection(selection);
    } catch {
      // ignore
    }
  };

  const refreshIfStale = () => {
    const now = Date.now();
    if (now - refreshAt < 1500) return;
    refreshAt = now;
    void (async () => {
      const token = (await loadSettings()).token;
      await refreshPresets(token);
    })();
  };

  const runRefreshFree = async () => {
    if (refreshFreeRunning) return;
    const token = (await loadSettings()).token.trim();
    if (!token) {
      setStatus("Setup required (missing token).", "error");
      return;
    }
    refreshFreeRunning = true;
    modelRefreshBtn.disabled = true;
    setStatus("Starting scan…", "running");
    let winnerModel: string | null = null;

    try {
      const response = await fetch("http://127.0.0.1:8787/v1/refresh-free", {
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

      const streamResponse = await fetch(
        `http://127.0.0.1:8787/v1/refresh-free/${json.id}/events`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
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
    isRefreshFreeRunning: () => refreshFreeRunning,
    readCurrentValue,
    refreshIfStale,
    refreshPresets,
    runRefreshFree,
    setDefaultPresets,
    setPlaceholderFromDiscovery,
    setStatus,
    setValue,
    updateRowUI,
  };
}
