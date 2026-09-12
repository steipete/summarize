import { daemonFetch } from "./daemon-fetch";
import { getDaemonOrigin } from "./daemon-url";

export function createModelPresetsController({
  presetEl,
  customEl,
  defaultValue,
  includeFree = false,
  includeCliHints = false,
  onUpdate,
  fetchImpl = daemonFetch,
}: {
  presetEl: HTMLSelectElement;
  customEl: HTMLInputElement;
  defaultValue: string;
  includeFree?: boolean;
  includeCliHints?: boolean;
  onUpdate?: () => void;
  fetchImpl?: typeof fetch;
}) {
  const setDefaultPresets = () => {
    presetEl.innerHTML = "";
    for (const [value, label] of [
      ["auto", "Auto"],
      ["browser/gemini-nano", "Gemini Nano (on-device)"],
      ["gpt-fast", "GPT Fast"],
      ...(includeFree ? [["free", "Free"]] : []),
      ["custom", "Custom…"],
    ]) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = label;
      presetEl.append(option);
    }
  };
  const setPlaceholderFromDiscovery = (discovery: {
    providers?: unknown;
    localModelsSource?: unknown;
  }) => {
    const hints = ["auto", "gpt-fast"];
    if (discovery.providers && typeof discovery.providers === "object") {
      const providers = discovery.providers as Record<string, unknown>;
      const providerHints = [
        ["openrouter", "free"],
        ["openai", "openai/…"],
        ["anthropic", "anthropic/…"],
        ["google", "google/…"],
        ["xai", "xai/…"],
        ["zai", "zai/…"],
        ...(includeCliHints
          ? [
              ["cliClaude", "cli/claude"],
              ["cliGemini", "cli/gemini"],
              ["cliCodex", "cli/codex"],
              ["cliAgent", "cli/agent"],
              ["cliOpenclaw", "cli/openclaw"],
              ["cliOpencode", "cli/opencode"],
              ["cliCopilot", "cli/copilot"],
              ["cliAgy", "cli/agy"],
              ["cliPi", "cli/pi"],
            ]
          : []),
      ];
      for (const [provider, hint] of providerHints) {
        if (providers[provider] === true) hints.push(hint);
      }
    }
    if (discovery.localModelsSource && typeof discovery.localModelsSource === "object")
      hints.push("local: openai/<id>");
    customEl.placeholder = hints.join(" / ");
  };
  const readCurrentValue = () =>
    presetEl.value === "custom" ? customEl.value || defaultValue : presetEl.value || defaultValue;
  const updateRowUI = () => {
    customEl.hidden = presetEl.value !== "custom";
    onUpdate?.();
  };
  const setValue = (value: string) => {
    const next = value.trim() || defaultValue;
    const hasPreset =
      next !== "custom" && Array.from(presetEl.options).some((option) => option.value === next);
    presetEl.value = hasPreset ? next : "custom";
    updateRowUI();
    if (!hasPreset) customEl.value = next;
  };
  const captureSelection = () => ({ presetValue: presetEl.value, customValue: customEl.value });
  const restoreSelection = (selection: ReturnType<typeof captureSelection>) => {
    if (selection.presetValue === "custom") {
      presetEl.value = "custom";
      updateRowUI();
      customEl.value = selection.customValue;
    } else {
      setValue(selection.presetValue);
    }
  };

  let refreshRequestId = 0;
  const refreshPresets = async (token: string) => {
    const requestId = ++refreshRequestId;
    const trimmed = token.trim();
    if (!trimmed) {
      const selection = captureSelection();
      setDefaultPresets();
      setPlaceholderFromDiscovery({});
      restoreSelection(selection);
      return;
    }
    try {
      const origin = await getDaemonOrigin();
      const response = await fetchImpl(`${origin}/v1/models`, {
        headers: { Authorization: `Bearer ${trimmed}` },
      });
      if (requestId !== refreshRequestId) return;
      if (!response.ok) {
        const selection = captureSelection();
        setDefaultPresets();
        restoreSelection(selection);
        return;
      }
      const json: unknown = await response.json();
      if (requestId !== refreshRequestId || !json || typeof json !== "object") return;
      const record = json as Record<string, unknown>;
      if (record.ok !== true) return;
      setPlaceholderFromDiscovery(record);
      if (!Array.isArray(record.options)) return;
      const options = record.options.flatMap((item): Array<{ id: string; label: string }> => {
        if (!item || typeof item !== "object") return [];
        const option = item as { id?: unknown; label?: unknown };
        const id = typeof option.id === "string" ? option.id.trim() : "";
        const label = typeof option.label === "string" ? option.label.trim() : "";
        return id ? [{ id, label }] : [];
      });
      const selection = captureSelection();
      setDefaultPresets();
      const seen = new Set(Array.from(presetEl.options).map((option) => option.value));
      for (const option of options) {
        if (seen.has(option.id)) continue;
        seen.add(option.id);
        const element = document.createElement("option");
        element.value = option.id;
        element.textContent = option.label ? `${option.id} — ${option.label}` : option.id;
        presetEl.append(element);
      }
      restoreSelection(selection);
    } catch {}
  };
  let lastRefreshAt = 0;
  const refreshIfStale = (token: string | (() => Promise<string>)) => {
    const now = Date.now();
    if (now - lastRefreshAt < 1500) return;
    lastRefreshAt = now;
    void (typeof token === "string" ? refreshPresets(token) : token().then(refreshPresets));
  };
  return {
    readCurrentValue,
    refreshIfStale,
    refreshPresets,
    setValue,
    setDefaultPresets,
    setPlaceholderFromDiscovery,
    updateRowUI,
  };
}
