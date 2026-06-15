import type { defaultSettings, SlideRuntime, SummaryRuntime } from "../../lib/settings";
import { createBooleanToggleController } from "./toggles";

type BooleanSettingsState = {
  autoSummarize: boolean;
  chatEnabled: boolean;
  automationEnabled: boolean;
  hoverSummaries: boolean;
  summaryTimestamps: boolean;
  slidesParallel: boolean;
  slideRuntime: SlideRuntime;
  summaryRuntime: SummaryRuntime;
  slidesOcrEnabled: boolean;
  extendedLogging: boolean;
  autoCliFallback: boolean;
};

type ToggleController = {
  render: () => void;
};

function createRuntimeController<T extends string>({
  root,
  name,
  normalize,
  getValue,
  setValue,
  scheduleAutoSave,
  afterChange,
}: {
  root: HTMLElement;
  name: string;
  normalize: (value: string) => T;
  getValue: () => T;
  setValue: (value: T) => void;
  scheduleAutoSave: (delay?: number) => void;
  afterChange?: () => void | Promise<void>;
}): ToggleController {
  const inputs = Array.from(root.querySelectorAll<HTMLInputElement>(`input[name="${name}"]`));

  for (const input of inputs) {
    input.addEventListener("change", () => {
      if (!input.checked) return;
      setValue(normalize(input.value));
      render();
      scheduleAutoSave(0);
      void afterChange?.();
    });
  }

  function render() {
    const value = getValue();
    for (const input of inputs) {
      input.checked = input.value === value;
      input.closest(".runtimeModeCard")?.toggleAttribute("data-selected", input.checked);
    }
  }

  return { render };
}

export function createBooleanSettingsRuntime(options: {
  defaults: typeof defaultSettings;
  roots: {
    autoToggleRoot: HTMLElement;
    chatToggleRoot: HTMLElement;
    automationToggleRoot: HTMLElement;
    hoverSummariesToggleRoot: HTMLElement;
    summaryTimestampsToggleRoot: HTMLElement;
    slidesParallelToggleRoot: HTMLElement;
    slideRuntimeModeRoot: HTMLElement;
    summaryRuntimeModeRoot: HTMLElement;
    slidesOcrToggleRoot: HTMLElement;
    extendedLoggingToggleRoot: HTMLElement;
    autoCliFallbackToggleRoot: HTMLElement;
  };
  scheduleAutoSave: (delayMs?: number) => void;
  onAutomationChanged?: () => void;
  onRuntimeChanged?: () => void;
}) {
  const state: BooleanSettingsState = {
    autoSummarize: options.defaults.autoSummarize,
    chatEnabled: options.defaults.chatEnabled,
    automationEnabled: options.defaults.automationEnabled,
    hoverSummaries: options.defaults.hoverSummaries,
    summaryTimestamps: options.defaults.summaryTimestamps,
    slidesParallel: options.defaults.slidesParallel,
    slideRuntime: options.defaults.slideRuntime,
    summaryRuntime: options.defaults.summaryRuntime,
    slidesOcrEnabled: options.defaults.slidesOcrEnabled,
    extendedLogging: options.defaults.extendedLogging,
    autoCliFallback: options.defaults.autoCliFallback,
  };

  const toggles: ToggleController[] = [
    createBooleanToggleController({
      root: options.roots.autoToggleRoot,
      id: "options-auto",
      label: "Auto-summarize when panel is open",
      getValue: () => state.autoSummarize,
      setValue: (checked) => {
        state.autoSummarize = checked;
      },
      scheduleAutoSave: options.scheduleAutoSave,
    }),
    createBooleanToggleController({
      root: options.roots.chatToggleRoot,
      id: "options-chat",
      label: "Enable Chat mode in the side panel",
      getValue: () => state.chatEnabled,
      setValue: (checked) => {
        state.chatEnabled = checked;
      },
      scheduleAutoSave: options.scheduleAutoSave,
    }),
    createBooleanToggleController({
      root: options.roots.automationToggleRoot,
      id: "options-automation",
      label: "Enable website automation",
      getValue: () => state.automationEnabled,
      setValue: (checked) => {
        state.automationEnabled = checked;
      },
      scheduleAutoSave: options.scheduleAutoSave,
      afterChange: options.onAutomationChanged,
    }),
    createBooleanToggleController({
      root: options.roots.hoverSummariesToggleRoot,
      id: "options-hover-summaries",
      label: "Hover summaries (experimental)",
      getValue: () => state.hoverSummaries,
      setValue: (checked) => {
        state.hoverSummaries = checked;
      },
      scheduleAutoSave: options.scheduleAutoSave,
    }),
    createBooleanToggleController({
      root: options.roots.summaryTimestampsToggleRoot,
      id: "options-summary-timestamps",
      label: "Summary timestamps (media only)",
      getValue: () => state.summaryTimestamps,
      setValue: (checked) => {
        state.summaryTimestamps = checked;
      },
      scheduleAutoSave: options.scheduleAutoSave,
    }),
    createBooleanToggleController({
      root: options.roots.slidesParallelToggleRoot,
      id: "options-slides-parallel",
      label: "Show summary first (parallel slides)",
      getValue: () => state.slidesParallel,
      setValue: (checked) => {
        state.slidesParallel = checked;
      },
      scheduleAutoSave: options.scheduleAutoSave,
    }),
    createRuntimeController({
      root: options.roots.summaryRuntimeModeRoot,
      name: "summaryRuntimeMode",
      normalize: (value): SummaryRuntime => (value === "daemon" ? "daemon" : "direct"),
      getValue: () => state.summaryRuntime,
      setValue: (value) => {
        state.summaryRuntime = value;
      },
      scheduleAutoSave: options.scheduleAutoSave,
      afterChange: options.onRuntimeChanged,
    }),
    createRuntimeController({
      root: options.roots.slideRuntimeModeRoot,
      name: "slideRuntimeMode",
      normalize: (value): SlideRuntime => (value === "daemon" ? "daemon" : "browser"),
      getValue: () => state.slideRuntime,
      setValue: (value) => {
        state.slideRuntime = value;
      },
      scheduleAutoSave: options.scheduleAutoSave,
      afterChange: options.onRuntimeChanged,
    }),
    createBooleanToggleController({
      root: options.roots.slidesOcrToggleRoot,
      id: "options-slides-ocr",
      label: "Enable OCR slide text",
      getValue: () => state.slidesOcrEnabled,
      setValue: (checked) => {
        state.slidesOcrEnabled = checked;
      },
      scheduleAutoSave: options.scheduleAutoSave,
    }),
    createBooleanToggleController({
      root: options.roots.extendedLoggingToggleRoot,
      id: "options-extended-logging",
      label: "Extended logging",
      getValue: () => state.extendedLogging,
      setValue: (checked) => {
        state.extendedLogging = checked;
      },
      scheduleAutoSave: options.scheduleAutoSave,
    }),
    createBooleanToggleController({
      root: options.roots.autoCliFallbackToggleRoot,
      id: "options-auto-cli-fallback",
      label: "Auto CLI fallback",
      getValue: () => state.autoCliFallback,
      setValue: (checked) => {
        state.autoCliFallback = checked;
      },
      scheduleAutoSave: options.scheduleAutoSave,
    }),
  ];

  return {
    getState: () => ({ ...state }),
    setState: (next: Partial<BooleanSettingsState>) => {
      Object.assign(state, next);
    },
    render: () => {
      for (const toggle of toggles) toggle.render();
    },
  };
}
