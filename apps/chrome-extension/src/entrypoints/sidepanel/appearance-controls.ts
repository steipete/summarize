import { defaultSettings } from "../../lib/settings";
import { applyTheme } from "../../lib/theme";
import { mountCheckbox } from "../../ui/checkbox";
import { mountSidepanelLengthPicker, mountSidepanelPickers } from "./pickers";

export function createAppearanceControls(options: {
  autoToggleRoot: HTMLDivElement;
  pickersRoot: HTMLDivElement;
  lengthRoot: HTMLDivElement;
  patchSettings: typeof import("../../lib/settings").patchSettings;
  sendSetAuto: (checked: boolean) => void;
  sendSetLength: (value: string) => void;
  applyTypography: (fontFamily: string, fontSize: number, lineHeight: number) => void;
}) {
  let pickerSettings = {
    scheme: defaultSettings.colorScheme,
    mode: defaultSettings.colorMode,
    fontFamily: defaultSettings.fontFamily,
    length: defaultSettings.length,
  };

  let autoValue = false;

  const updateAutoToggle = () => {
    autoToggle.update({
      id: "sidepanel-auto",
      label: "Auto summarize",
      checked: autoValue,
      onCheckedChange: (checked) => {
        autoValue = checked;
        options.sendSetAuto(checked);
      },
    });
  };

  const pickerHandlers = {
    onSchemeChange: (value: string) => {
      void (async () => {
        const next = await options.patchSettings({ colorScheme: value });
        pickerSettings = { ...pickerSettings, scheme: next.colorScheme, mode: next.colorMode };
        applyTheme({ scheme: next.colorScheme, mode: next.colorMode });
      })();
    },
    onModeChange: (value: string) => {
      void (async () => {
        const next = await options.patchSettings({ colorMode: value });
        pickerSettings = { ...pickerSettings, scheme: next.colorScheme, mode: next.colorMode };
        applyTheme({ scheme: next.colorScheme, mode: next.colorMode });
      })();
    },
    onFontChange: (value: string) => {
      void (async () => {
        const next = await options.patchSettings({ fontFamily: value });
        pickerSettings = { ...pickerSettings, fontFamily: next.fontFamily };
        options.applyTypography(next.fontFamily, next.fontSize, next.lineHeight);
      })();
    },
    onLengthChange: (value: string) => {
      pickerSettings = { ...pickerSettings, length: value };
      options.sendSetLength(value);
    },
  };

  const pickers = mountSidepanelPickers(options.pickersRoot, {
    scheme: pickerSettings.scheme,
    mode: pickerSettings.mode,
    fontFamily: pickerSettings.fontFamily,
    onSchemeChange: pickerHandlers.onSchemeChange,
    onModeChange: pickerHandlers.onModeChange,
    onFontChange: pickerHandlers.onFontChange,
  });

  const lengthPicker = mountSidepanelLengthPicker(options.lengthRoot, {
    length: pickerSettings.length,
    onLengthChange: pickerHandlers.onLengthChange,
  });

  const autoToggle = mountCheckbox(options.autoToggleRoot, {
    id: "sidepanel-auto",
    label: "Auto summarize",
    checked: autoValue,
    onCheckedChange: (checked) => {
      autoValue = checked;
      options.sendSetAuto(checked);
    },
  });

  return {
    getLengthValue: () => pickerSettings.length,
    getFontFamily: () => pickerSettings.fontFamily,
    setAutoValue: (checked: boolean) => {
      if (autoValue === checked) return;
      autoValue = checked;
      updateAutoToggle();
    },
    syncLengthFromState: (length: string) => {
      if (pickerSettings.length === length) return false;
      pickerSettings = { ...pickerSettings, length };
      lengthPicker.update({
        length: pickerSettings.length,
        onLengthChange: pickerHandlers.onLengthChange,
      });
      return true;
    },
    initializeFromSettings: (settings: {
      autoSummarize: boolean;
      colorScheme: string;
      colorMode: string;
      fontFamily: string;
      length: string;
      fontSize: number;
      lineHeight: number;
    }) => {
      autoValue = settings.autoSummarize;
      updateAutoToggle();
      pickerSettings = {
        scheme: settings.colorScheme,
        mode: settings.colorMode,
        fontFamily: settings.fontFamily,
        length: settings.length,
      };
      pickers.update({
        scheme: pickerSettings.scheme,
        mode: pickerSettings.mode,
        fontFamily: pickerSettings.fontFamily,
        onSchemeChange: pickerHandlers.onSchemeChange,
        onModeChange: pickerHandlers.onModeChange,
        onFontChange: pickerHandlers.onFontChange,
      });
      lengthPicker.update({
        length: pickerSettings.length,
        onLengthChange: pickerHandlers.onLengthChange,
      });
      options.applyTypography(settings.fontFamily, settings.fontSize, settings.lineHeight);
      applyTheme({ scheme: settings.colorScheme, mode: settings.colorMode });
    },
  };
}
