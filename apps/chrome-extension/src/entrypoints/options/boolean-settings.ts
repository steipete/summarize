import type { defaultSettings } from "../../lib/settings";
import { createBooleanToggleController } from "./toggles";

type BooleanSettingsState = {
  autoSummarize: boolean;
  chatEnabled: boolean;
  automationEnabled: boolean;
  hoverSummaries: boolean;
  summaryTimestamps: boolean;
  slidesParallel: boolean;
  slidesOcrEnabled: boolean;
  extendedLogging: boolean;
  autoCliFallback: boolean;
};

type ToggleController = {
  render: () => void;
};

export function createBooleanSettingsRuntime(options: {
  defaults: typeof defaultSettings;
  roots: {
    autoToggleRoot: HTMLElement;
    chatToggleRoot: HTMLElement;
    automationToggleRoot: HTMLElement;
    hoverSummariesToggleRoot: HTMLElement;
    summaryTimestampsToggleRoot: HTMLElement;
    slidesParallelToggleRoot: HTMLElement;
    slidesOcrToggleRoot: HTMLElement;
    extendedLoggingToggleRoot: HTMLElement;
    autoCliFallbackToggleRoot: HTMLElement;
  };
  scheduleAutoSave: (delayMs?: number) => void;
  onAutomationChanged?: () => void;
}) {
  const state: BooleanSettingsState = {
    autoSummarize: options.defaults.autoSummarize,
    chatEnabled: options.defaults.chatEnabled,
    automationEnabled: options.defaults.automationEnabled,
    hoverSummaries: options.defaults.hoverSummaries,
    summaryTimestamps: options.defaults.summaryTimestamps,
    slidesParallel: options.defaults.slidesParallel,
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
