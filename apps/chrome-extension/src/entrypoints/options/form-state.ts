import { readPresetOrCustomValue, resolvePresetOrCustom } from "../../lib/combo";
import type { DirectProvider, Settings, SlideRuntime, SummaryRuntime } from "../../lib/settings";
import type { ColorMode, ColorScheme } from "../../lib/theme";
import type { createModelPresetsController } from "./model-presets";

type FormElements = {
  tokenEl: HTMLInputElement;
  providerEl: HTMLSelectElement;
  providerApiKeyEl: HTMLInputElement;
  providerBaseUrlEl: HTMLInputElement;
  languagePresetEl: HTMLSelectElement;
  languageCustomEl: HTMLInputElement;
  promptOverrideEl: HTMLTextAreaElement;
  hoverPromptEl: HTMLTextAreaElement;
  autoCliOrderEl: HTMLInputElement;
  maxCharsEl: HTMLInputElement;
  requestModeEl: HTMLSelectElement;
  firecrawlModeEl: HTMLSelectElement;
  markdownModeEl: HTMLSelectElement;
  preprocessModeEl: HTMLSelectElement;
  youtubeModeEl: HTMLSelectElement;
  transcriberEl: HTMLSelectElement;
  timeoutEl: HTMLInputElement;
  retriesEl: HTMLInputElement;
  maxOutputTokensEl: HTMLInputElement;
  fontFamilyEl: HTMLInputElement;
  fontSizeEl: HTMLInputElement;
};

type BooleanFormState = {
  autoSummarize: boolean;
  hoverSummaries: boolean;
  chatEnabled: boolean;
  automationEnabled: boolean;
  slidesParallel: boolean;
  slideRuntime: SlideRuntime;
  summaryRuntime: SummaryRuntime;
  slidesOcrEnabled: boolean;
  summaryTimestamps: boolean;
  extendedLogging: boolean;
  autoCliFallback: boolean;
};

export function buildSavedOptionsSettings({
  current,
  defaults,
  elements,
  modelPresets,
  booleans,
  currentScheme,
  currentMode,
}: {
  current: Settings;
  defaults: Settings;
  elements: FormElements;
  modelPresets: ReturnType<typeof createModelPresetsController>;
  booleans: BooleanFormState;
  currentScheme: ColorScheme;
  currentMode: ColorMode;
}): Settings {
  return {
    token: elements.tokenEl.value || defaults.token,
    summaryRuntime: booleans.summaryRuntime,
    provider: elements.providerEl.value as DirectProvider,
    providerApiKeys: {
      ...current.providerApiKeys,
      [elements.providerEl.value]: elements.providerApiKeyEl.value.trim(),
    },
    providerBaseUrls: {
      ...current.providerBaseUrls,
      [elements.providerEl.value]: elements.providerBaseUrlEl.value.trim(),
    },
    model: modelPresets.readCurrentValue(),
    length: current.length,
    language: readPresetOrCustomValue({
      presetValue: elements.languagePresetEl.value,
      customValue: elements.languageCustomEl.value,
      defaultValue: defaults.language,
    }),
    promptOverride: elements.promptOverrideEl.value || defaults.promptOverride,
    hoverPrompt: elements.hoverPromptEl.value || defaults.hoverPrompt,
    autoSummarize: booleans.autoSummarize,
    hoverSummaries: booleans.hoverSummaries,
    chatEnabled: booleans.chatEnabled,
    automationEnabled: booleans.automationEnabled,
    slidesEnabled: current.slidesEnabled,
    slideRuntime: booleans.slideRuntime,
    slidesParallel: booleans.slidesParallel,
    slidesOcrEnabled: booleans.slidesOcrEnabled,
    slidesLayout: current.slidesLayout,
    summaryTimestamps: booleans.summaryTimestamps,
    extendedLogging: booleans.extendedLogging,
    autoCliFallback: booleans.autoCliFallback,
    autoCliOrder: elements.autoCliOrderEl.value || defaults.autoCliOrder,
    maxChars: Number(elements.maxCharsEl.value) || defaults.maxChars,
    requestMode: elements.requestModeEl.value || defaults.requestMode,
    firecrawlMode: elements.firecrawlModeEl.value || defaults.firecrawlMode,
    markdownMode: elements.markdownModeEl.value || defaults.markdownMode,
    preprocessMode: elements.preprocessModeEl.value || defaults.preprocessMode,
    youtubeMode: elements.youtubeModeEl.value || defaults.youtubeMode,
    transcriber: elements.transcriberEl.value || defaults.transcriber,
    timeout: elements.timeoutEl.value || defaults.timeout,
    retries: (() => {
      const raw = elements.retriesEl.value.trim();
      if (!raw) return defaults.retries;
      const parsed = Number(raw);
      return Number.isFinite(parsed) ? parsed : defaults.retries;
    })(),
    maxOutputTokens: elements.maxOutputTokensEl.value || defaults.maxOutputTokens,
    colorScheme: currentScheme || defaults.colorScheme,
    colorMode: currentMode || defaults.colorMode,
    fontFamily: elements.fontFamilyEl.value || defaults.fontFamily,
    fontSize: Number(elements.fontSizeEl.value) || defaults.fontSize,
    lineHeight: current.lineHeight,
  };
}

export function applyLoadedOptionsSettings({
  settings,
  defaults,
  languagePresets,
  elements,
}: {
  settings: Settings;
  defaults: Settings;
  languagePresets: string[];
  elements: FormElements;
}) {
  elements.tokenEl.value = settings.token;
  elements.providerEl.value = settings.provider;
  elements.providerApiKeyEl.value = settings.providerApiKeys[settings.provider] ?? "";
  elements.providerBaseUrlEl.value = settings.providerBaseUrls[settings.provider] ?? "";
  {
    const resolved = resolvePresetOrCustom({
      value: settings.language,
      presets: languagePresets,
    });
    elements.languagePresetEl.value = resolved.presetValue;
    elements.languageCustomEl.hidden = !resolved.isCustom;
    elements.languageCustomEl.value = resolved.customValue;
  }
  elements.promptOverrideEl.value = settings.promptOverride;
  elements.hoverPromptEl.value = settings.hoverPrompt || defaults.hoverPrompt;
  elements.autoCliOrderEl.value = settings.autoCliOrder;
  elements.maxCharsEl.value = String(settings.maxChars);
  elements.requestModeEl.value = settings.requestMode;
  elements.firecrawlModeEl.value = settings.firecrawlMode;
  elements.markdownModeEl.value = settings.markdownMode;
  elements.preprocessModeEl.value = settings.preprocessMode;
  elements.youtubeModeEl.value = settings.youtubeMode;
  elements.transcriberEl.value = settings.transcriber;
  elements.timeoutEl.value = settings.timeout;
  elements.retriesEl.value = typeof settings.retries === "number" ? String(settings.retries) : "";
  elements.maxOutputTokensEl.value = settings.maxOutputTokens;
  elements.fontFamilyEl.value = settings.fontFamily;
  elements.fontSizeEl.value = String(settings.fontSize);

  return {
    booleans: {
      autoSummarize: settings.autoSummarize,
      hoverSummaries: settings.hoverSummaries,
      chatEnabled: settings.chatEnabled,
      automationEnabled: settings.automationEnabled,
      slidesParallel: settings.slidesParallel,
      slideRuntime: settings.slideRuntime,
      summaryRuntime: settings.summaryRuntime,
      slidesOcrEnabled: settings.slidesOcrEnabled,
      summaryTimestamps: settings.summaryTimestamps,
      extendedLogging: settings.extendedLogging,
      autoCliFallback: settings.autoCliFallback,
    },
    colorScheme: settings.colorScheme,
    colorMode: settings.colorMode,
  };
}
