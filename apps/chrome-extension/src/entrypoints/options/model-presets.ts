export function createModelPresetsController({
  presetEl,
  customEl,
  defaultValue,
  fetchImpl = fetch,
}: {
  presetEl: HTMLSelectElement;
  customEl: HTMLInputElement;
  defaultValue: string;
  fetchImpl?: typeof fetch;
}) {
  const setDefaultPresets = () => {
    presetEl.innerHTML = "";
    const auto = document.createElement("option");
    auto.value = "auto";
    auto.textContent = "Auto";
    presetEl.append(auto);
    const custom = document.createElement("option");
    custom.value = "custom";
    custom.textContent = "Custom…";
    presetEl.append(custom);
  };

  const setPlaceholderFromDiscovery = (discovery: {
    providers?: unknown;
    localModelsSource?: unknown;
  }) => {
    const hints: string[] = ["auto"];
    const providers = discovery.providers;
    if (providers && typeof providers === "object") {
      const p = providers as Record<string, unknown>;
      if (p.openrouter === true) hints.push("free");
      if (p.openai === true) hints.push("openai/…");
      if (p.anthropic === true) hints.push("anthropic/…");
      if (p.google === true) hints.push("google/…");
      if (p.xai === true) hints.push("xai/…");
      if (p.zai === true) hints.push("zai/…");
      if (p.cliClaude === true) hints.push("cli/claude");
      if (p.cliGemini === true) hints.push("cli/gemini");
      if (p.cliCodex === true) hints.push("cli/codex");
      if (p.cliAgent === true) hints.push("cli/agent");
      if (p.cliOpenclaw === true) hints.push("cli/openclaw");
      if (p.cliOpencode === true) hints.push("cli/opencode");
    }
    if (discovery.localModelsSource && typeof discovery.localModelsSource === "object") {
      hints.push("local: openai/<id>");
    }
    customEl.placeholder = hints.join(" / ");
  };

  const readCurrentValue = () =>
    presetEl.value === "custom" ? customEl.value || defaultValue : presetEl.value || defaultValue;

  const setValue = (value: string) => {
    const next = value.trim() || defaultValue;
    const optionValues = new Set(Array.from(presetEl.options).map((o) => o.value));
    if (optionValues.has(next) && next !== "custom") {
      presetEl.value = next;
      customEl.hidden = true;
      return;
    }
    presetEl.value = "custom";
    customEl.hidden = false;
    customEl.value = next;
  };

  const captureSelection = () => ({
    presetValue: presetEl.value,
    customValue: customEl.value,
  });

  const restoreSelection = (selection: { presetValue: string; customValue: string }) => {
    if (selection.presetValue === "custom") {
      presetEl.value = "custom";
      customEl.hidden = false;
      customEl.value = selection.customValue;
      return;
    }
    const optionValues = new Set(Array.from(presetEl.options).map((o) => o.value));
    if (optionValues.has(selection.presetValue) && selection.presetValue !== "custom") {
      presetEl.value = selection.presetValue;
      customEl.hidden = true;
      return;
    }
    setValue(selection.presetValue);
  };

  const refreshPresets = async (token: string) => {
    const selection = captureSelection();
    const trimmed = token.trim();
    if (!trimmed) {
      setDefaultPresets();
      setPlaceholderFromDiscovery({});
      restoreSelection(selection);
      return;
    }
    try {
      const res = await fetchImpl("http://127.0.0.1:8787/v1/models", {
        headers: { Authorization: `Bearer ${trimmed}` },
      });
      if (!res.ok) {
        setDefaultPresets();
        restoreSelection(selection);
        return;
      }
      const json = (await res.json()) as unknown;
      if (!json || typeof json !== "object") return;
      const obj = json as Record<string, unknown>;
      if (obj.ok !== true) return;

      setPlaceholderFromDiscovery({
        providers: obj.providers,
        localModelsSource: obj.localModelsSource,
      });

      const optionsRaw = obj.options;
      if (!Array.isArray(optionsRaw)) return;
      const options = optionsRaw
        .map((item) => {
          if (!item || typeof item !== "object") return null;
          const record = item as { id?: unknown; label?: unknown };
          const id = typeof record.id === "string" ? record.id.trim() : "";
          const label = typeof record.label === "string" ? record.label.trim() : "";
          if (!id) return null;
          return { id, label };
        })
        .filter((x): x is { id: string; label: string } => x !== null);

      if (options.length === 0) {
        setDefaultPresets();
        restoreSelection(selection);
        return;
      }

      setDefaultPresets();
      const seen = new Set(Array.from(presetEl.options).map((o) => o.value));
      for (const opt of options) {
        if (seen.has(opt.id)) continue;
        seen.add(opt.id);
        const el = document.createElement("option");
        el.value = opt.id;
        el.textContent = opt.label ? `${opt.id} — ${opt.label}` : opt.id;
        presetEl.append(el);
      }
      restoreSelection(selection);
    } catch {
      // ignore
    }
  };

  let lastRefreshAt = 0;
  const refreshIfStale = (token: string) => {
    const now = Date.now();
    if (now - lastRefreshAt < 1500) return;
    lastRefreshAt = now;
    void refreshPresets(token);
  };

  setDefaultPresets();

  return {
    readCurrentValue,
    refreshIfStale,
    refreshPresets,
    setValue,
  };
}
