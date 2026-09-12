import type { defaultSettings, SlideRuntime, SummaryRuntime } from "../../lib/settings";
import { createBooleanToggleController } from "./toggles";

export type BooleanSettingsState = {
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

const booleanControls = [
  {
    key: "autoSummarize",
    root: "autoToggleRoot",
    id: "options-auto",
    label: "Auto-summarize when panel is open",
  },
  {
    key: "chatEnabled",
    root: "chatToggleRoot",
    id: "options-chat",
    label: "Enable Chat mode in the side panel",
  },
  {
    key: "automationEnabled",
    root: "automationToggleRoot",
    id: "options-automation",
    label: "Enable website automation",
  },
  {
    key: "hoverSummaries",
    root: "hoverSummariesToggleRoot",
    id: "options-hover-summaries",
    label: "Hover summaries (experimental)",
  },
  {
    key: "summaryTimestamps",
    root: "summaryTimestampsToggleRoot",
    id: "options-summary-timestamps",
    label: "Summary timestamps (media only)",
  },
  {
    key: "slidesParallel",
    root: "slidesParallelToggleRoot",
    id: "options-slides-parallel",
    label: "Show summary first (parallel slides)",
  },
  {
    key: "slidesOcrEnabled",
    root: "slidesOcrToggleRoot",
    id: "options-slides-ocr",
    label: "Enable OCR slide text",
  },
  {
    key: "extendedLogging",
    root: "extendedLoggingToggleRoot",
    id: "options-extended-logging",
    label: "Extended logging",
  },
  {
    key: "autoCliFallback",
    root: "autoCliFallbackToggleRoot",
    id: "options-auto-cli-fallback",
    label: "Auto CLI fallback",
  },
] as const;

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
  beforeChange,
  afterChange,
}: {
  root: HTMLElement;
  name: string;
  normalize: (value: string) => T;
  getValue: () => T;
  setValue: (value: T) => void;
  scheduleAutoSave: (delay?: number) => void;
  beforeChange?: (value: T) => boolean | Promise<boolean>;
  afterChange?: () => void | Promise<void>;
}): ToggleController {
  const inputs = Array.from(root.querySelectorAll<HTMLInputElement>(`input[name="${name}"]`));

  for (const input of inputs) {
    input.addEventListener("change", () => {
      if (!input.checked) return;
      const nextValue = normalize(input.value);
      void (async () => {
        if (beforeChange && !(await beforeChange(nextValue))) {
          render();
          return;
        }
        setValue(nextValue);
        render();
        scheduleAutoSave(0);
        await afterChange?.();
      })();
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
  ensureDaemonEnabled?: () => boolean | Promise<boolean>;
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
    ...booleanControls.map(({ key, root, id, label }) =>
      createBooleanToggleController({
        root: options.roots[root],
        id,
        label,
        getValue: () => state[key],
        setValue: (checked) => {
          state[key] = checked;
        },
        scheduleAutoSave: options.scheduleAutoSave,
        afterChange: key === "automationEnabled" ? options.onAutomationChanged : undefined,
      }),
    ),
    createRuntimeController({
      root: options.roots.summaryRuntimeModeRoot,
      name: "summaryRuntimeMode",
      normalize: (value): SummaryRuntime => (value === "daemon" ? "daemon" : "direct"),
      getValue: () => state.summaryRuntime,
      setValue: (value) => {
        state.summaryRuntime = value;
      },
      scheduleAutoSave: options.scheduleAutoSave,
      beforeChange: (value) =>
        value !== "daemon" || !options.ensureDaemonEnabled ? true : options.ensureDaemonEnabled(),
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
      beforeChange: (value) =>
        value !== "daemon" || !options.ensureDaemonEnabled ? true : options.ensureDaemonEnabled(),
      afterChange: options.onRuntimeChanged,
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
